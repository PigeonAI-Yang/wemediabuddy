import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentProjectDetail, ContentProjectOrder, ContentProjectPlatform, ContentProjectStatus, ContentProjectStatusSummary, ContentProjectSummary } from '../main/content';
import type { StudioAnnotation, StudioDocumentScope, StudioPlatform } from '../shared/studio-annotations';
import { assetImageToken, bodyWithoutLeadingTitle, contentMediaLayoutMap, formatAssetSize, formatTime, htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, parseAssetImages, platformNames, removeAssetImageToken, renderMarkdown, replaceAssetImageToken, statuses, updateAssetImageAlt, updateContentMediaBinding, wrapTextareaSelection, type StudioAssetImageRef } from './studio-view-helpers';
import { StudioEditorTop, StudioFormatBar, StudioHistoryModal, StudioLibraryHeader, StudioLibraryView, StudioOutline } from './studio-view-panels';
import { StudioInvestigationPanel } from './studio-investigation-panel';
import { studioInvestigationIndicator, type StudioInvestigationIndicator } from './studio-investigation-indicator';
import { StudioInlineImageOverlay, type InlineImageDraft, type InlineImageSelection } from './studio-image-toolbar';
import { StudioImageCropDialog, type StudioCropApplyResult, type StudioDeriveCropInput, type StudioDeriveCropResult } from './studio-image-crop';
import { buildAssetIdsFromPlatformBindings, contentBindingKey, type ContentMediaBinding, type ContentMediaBindingDraft, type MediaAlign, type MediaWidthPreset, type PlatformCropPayload, type PlatformMediaBindingDraft } from '../shared/media-bindings';
import { createStudioPlatformDraft, isStudioPlatformDraftDirty, addVideoPlatformBinding, platformBindingsToDrafts, platformMediaBindingsEqual, readPlatformVersionBindings, selectStudioPlatformVersion, setPlatformBindingCaption, setPlatformBindingClipRange, setPlatformBindingPoster, setPlatformCover, shiftPlatformBindingOrdinal, studioPlatformDraftKey, studioPlatformFromTab, syncPlatformBindingsToRefs, type StudioPlatformDraft, type StudioTab } from './studio-platform-tabs';
import { StudioMediaSuggestions, formatMs } from './studio-media-suggestions';
import type { MediaRecommendation, MediaRecommendationsReadModel } from '../shared/media-recommendations';
import type { IllustrationRatio, IllustrationRun } from '../shared/illustration-workflow';
import { annotationContextAround, annotationScopeKey, computeBodyFingerprint, leadingTitleLength, trimToNonWhitespace, validateAnnotationSelection, shiftAnnotationRanges, type StudioAnnotationRow } from './studio-annotations';
import { StudioAnnotationMenu, StudioAnnotationNoteInput, StudioAnnotationOverlay, bodyOffsetAtDomPoint, richMapping, type SourceHitTest } from './studio-annotation-layer';
import { appConfirm } from './app-confirm';
import { priorityGrade } from './today-view-parts';
import { SourcePlatformMark } from './source-mark';
import { captureRichInsertionBookmark, type EditorInsertionBookmark } from './studio-view-dom';
import { coreBindingsFromDetail, coreMediaBindingsEqual } from './studio-view-media';
import { RESEARCH_DECISION_LABEL, StudioIllustrationPanel, StudioResearchGate, useStudioIllustrations, useStudioResearchGaps, type StudioFocusObject, type StudioResearchGapItem } from './studio-view-research';
import { useStudioInlineImages } from './studio-view-inline-images';
import { useStudioEditorOps } from './studio-view-editor-ops';
import { useStudioAnnotations } from './studio-view-annotations';
import { useStudioSave } from './studio-view-save';
import { useStudioRecommendations } from './studio-view-recommendations';
import { useStudioImageHandlers } from './studio-view-image-handlers';

type StudioSelectionSnapshot = { start: number; end: number; basis: string };

export function LongTermStudioView({ openPublish, selectedId, onSelect, onContext, onFocusChange, onOpenSource, planDate, enabledPlatforms, aiSourcePresentation }: {
  openPublish: () => void; selectedId: string | null; onSelect: (projectId: string | null) => void;
  onContext: (project: { id: string; title: string } | null) => void;
  onFocusChange?: (focus: StudioFocusObject | null) => void;
  onOpenSource?: (sourceId: string) => void;
  planDate: string; enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'>;
  aiSourcePresentation: boolean;
}): React.JSX.Element {
  const [projects, setProjects] = useState<ContentProjectSummary[]>([]); const [topics,setTopics]=useState<any[]>([]);
  const [listFocusId, setListFocusId] = useState<string | null>(null);
  const [statusSummary, setStatusSummary] = useState<ContentProjectStatusSummary | null>(null);
  const [selected, setSelected] = useState<ContentProjectDetail | null>(null); const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState<ContentProjectStatus | undefined>();
  const [archived, setArchived] = useState(false); const [order, setOrder] = useState<ContentProjectOrder>('recent');
  const [platform, setPlatform] = useState<ContentProjectPlatform | undefined>(); const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0); const [loading, setLoading] = useState(true); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [title, setTitle] = useState(''); const [body, setBody] = useState('');
  const [tab, setTab] = useState<StudioTab>('core');
  const [platformSelections, setPlatformSelections] = useState<Partial<Record<ContentProjectPlatform, string>>>({});
  const [platformDrafts, setPlatformDrafts] = useState<Record<string, StudioPlatformDraft>>({});
  const [contextTab, setContextTab] = useState<'versions' | 'sources' | 'assets'>('versions'); const [viewedVersionId, setViewedVersionId] = useState<string | null>(null);
  const [annotationRows, setAnnotationRows] = useState<StudioAnnotationRow[]>([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [annotationsError, setAnnotationsError] = useState<string | null>(null);
  const [annotationReloadTick, setAnnotationReloadTick] = useState(0);
  const [contextPanelTab, setContextPanelTab] = useState<'annotations' | 'versions'>('versions');
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [flashAnnotationId, setFlashAnnotationId] = useState<string | null>(null);
  const [annotationMenu, setAnnotationMenu] = useState<{ x: number; y: number; kind: 'create'; snapshot: StudioSelectionSnapshot } | { x: number; y: number; kind: 'edit'; annotationId: string } | null>(null);
  const [noteInput, setNoteInput] = useState<{ x: number; y: number; mode: 'create'; snapshot: StudioSelectionSnapshot } | { x: number; y: number; mode: 'edit'; annotationId: string; initial: string } | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const annotationBasisRef = useRef<string>('');
  const backendBodyRef = useRef<string>('');
  const rowsScopeKeyRef = useRef<string>('');
  const reconcileTimer = useRef<number | undefined>(undefined);
  const annotationSyncGuardRef = useRef(0);
  const pendingExternalReplaceRef = useRef(false);
  const annotationSyncPromiseRef = useRef<Promise<boolean> | null>(null);
  const [copyTitle, setCopyTitle] = useState(''); const [copyOpen, setCopyOpen] = useState(false); const [findOpen, setFindOpen] = useState(false); const [findText, setFindText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false); const [editorMode, setEditorMode] = useState<'rich' | 'source'>('source');
  const [investigationIndicator, setInvestigationIndicator] = useState<StudioInvestigationIndicator>(() => studioInvestigationIndicator(null));
  const { researchGapRows, researchGapForProject, researchGapsError, researchBusyId, researchGapMessage, decideResearchGap } = useStudioResearchGaps(selectedId);
  const [creating, setCreating] = useState(false); const [newTitle, setNewTitle] = useState('');
  const [illustrationRuns, setIllustrationRuns] = useState<IllustrationRun[]>([]);
  const [illustrationRatio, setIllustrationRatio] = useState<IllustrationRatio>('16:9');
  const [illustrationMaxGenerated, setIllustrationMaxGenerated] = useState(6);
  const [illustrationBusy, setIllustrationBusy] = useState(false);
  const [illustrationRequest, setIllustrationRequest] = useState('');
  const [illustrationImageModel, setIllustrationImageModel] = useState('');
  const [illustrationProfileId, setIllustrationProfileId] = useState('');
  const bodyInput = useRef<HTMLDivElement>(null); const sourceInput = useRef<HTMLTextAreaElement>(null);
  // 富文本编辑器 DOM 已反映 editorBody（输入/execCommand 路径置位）：此时回填会重建子树、
  // 丢失光标与输入法组合；非 DOM 路径（撤销/页签切换/外部改写）保持 false，允许回填。
  const richDomSyncedRef = useRef(false);
  const richWrapRef = useRef<HTMLDivElement>(null); const sourceWrapRef = useRef<HTMLDivElement>(null);
  const sourceHitTestRef = useRef<SourceHitTest | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useRef<HTMLInputElement>(null); const importInput = useRef<HTMLInputElement>(null);
  // WMB-5237 本文图片菜单
  const imageMenuButtonRef = useRef<HTMLButtonElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const replaceImageInput = useRef<HTMLInputElement>(null);
  const pendingReplaceRef = useRef<{ assetId: string; occurrence: number } | null>(null);
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const [imageMenuRect, setImageMenuRect] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [imageMenuEditKey, setImageMenuEditKey] = useState<string | null>(null);
  // WMB-5246 素材建议：读模型经 media-recommendations:* IPC（生成/决定/列出）；接受仍是独立保存边界。
  const [mediaRecommendations, setMediaRecommendations] = useState<MediaRecommendationsReadModel | null>(null);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [recommendationsGenerating, setRecommendationsGenerating] = useState(false);
  const [videoClipEdit, setVideoClipEdit] = useState<{ assetId: string; start: string; end: string } | null>(null);
  const [imageMenuAltDrafts, setImageMenuAltDrafts] = useState<Record<string, string>>({});
  const [imageMenuBusyIndex, setImageMenuBusyIndex] = useState<number | null>(null);
  // WMB-5237 裁切对话框：裁切是强专注任务，打开时以标准 dialog 覆盖
  const [cropTarget, setCropTarget] = useState<{ assetId: string; occurrence: number; alt: string; assetName?: string | null } | null>(null);
  // WMB-5237 平台页签待保存裁切像素（save 时由后端物化派生 asset；实现与清理归 ImplementPlatformMediaProjection）
  const [platformCropPayloads, setPlatformCropPayloads] = useState<Record<string, PlatformCropPayload>>({});
  // WMB-5237 核心媒体布局草稿（widthPreset/align/图注，key=assetId:occurrence；布局只进草稿，不改正文 token）
  const [coreMediaDraft, setCoreMediaDraft] = useState<ContentMediaBindingDraft[]>([]);
  const [coreMediaBase, setCoreMediaBase] = useState<ContentMediaBindingDraft[]>([]);
  // WMB-5237 正文内图片：点击选中态（浮动工具条/拖拽手柄；只读历史仅定位查看）
  const [inlineSelection, setInlineSelection] = useState<InlineImageSelection | null>(null);
  const draggedFigureRef = useRef<HTMLElement | null>(null);
  const dropTargetRef = useRef<{ block: HTMLElement; position: 'before' | 'after' } | null>(null);
  const bodyHistory = useRef<string[]>(['']); const bodyHistoryIndex = useRef(0);
  const latest = selected?.revisions[0]; const viewedVersion = selected?.revisions.find((version) => version.id === viewedVersionId) ?? null;
  const activePlatform = studioPlatformFromTab(tab);
  const activePlatformVersion = activePlatform
    ? selectStudioPlatformVersion(selected?.platformVersions[activePlatform] ?? [], platformSelections[activePlatform])
    : null;
  const activePlatformDraftKey = activePlatform ? studioPlatformDraftKey(activePlatform, activePlatformVersion) : null;
  const activePlatformDraft = activePlatformDraftKey ? platformDrafts[activePlatformDraftKey] : undefined;
  const editorTitle = activePlatform ? activePlatformDraft?.title ?? activePlatformVersion?.title ?? '' : title;
  const editorBody = activePlatform ? activePlatformDraft?.body ?? activePlatformVersion?.body ?? '' : body;
  const coreDirty = Boolean(selected) && (title.trim() !== selected?.title.trim() || body !== (latest?.body ?? '') || !coreMediaBindingsEqual(coreMediaDraft, coreMediaBase));
  const dirty = activePlatform ? Boolean(activePlatformDraft && isStudioPlatformDraftDirty(activePlatformDraft)) : coreDirty;
  const anyDirty = coreDirty || Object.values(platformDrafts).some(isStudioPlatformDraftDirty);
  const annotationScope = useMemo<StudioDocumentScope | null>(() => {
    if (!selected) return null;
    if (activePlatform) {
      return {
        projectId: selected.id,
        documentKind: 'platform',
        documentId: activePlatformVersion?.id ?? activePlatformVersion?.contentVersionId ?? latest?.id ?? null,
        platform: activePlatform
      };
    }
    return { projectId: selected.id, documentKind: 'core', documentId: latest?.id ?? null, platform: null };
  }, [selected, activePlatform, activePlatformVersion?.id, activePlatformVersion?.contentVersionId, latest?.id]);
  const annotationScopeKeyValue = annotationScope ? annotationScopeKey(annotationScope) : '';
  const openAnnotationRows = useMemo(() => annotationRows.filter((row) => row.status === 'open'), [annotationRows]);
  // 装饰层只渲染当前 scope 的开放批注（scope 切换加载期间不投射旧文档标记）
  const visibleOpenAnnotations = rowsScopeKeyRef.current === annotationScopeKeyValue ? openAnnotationRows : [];
  const annotationLeadingTitleLen = leadingTitleLength(editorBody);
  const annotationVersionCount = activePlatform
    ? (selected?.platformVersions[activePlatform]?.length ?? 0)
    : (selected?.revisions.length ?? 0);
  const input = { query: query || undefined, status, archived, order, platform, limit: 50 };
  const loadFirst = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [result, nextSummary] = await Promise.all([
        window.wmb.listStudioProjects({ ...input, offset }),
        window.wmb.getStudioSummary()
      ]);
      const page = result?.items ?? [];
      setProjects(page);
      setHasMore(Boolean(result?.hasMore));
      setStatusSummary(nextSummary);
      setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const loadDetail = async (id: string) => {
    try {
      const detail = await window.wmb.getStudioProject(id);
      setSelected(detail);
      setInvestigationIndicator(studioInvestigationIndicator(detail?.investigation));
      setTitle(detail?.title ?? '');
      const latestBody = detail?.revisions[0]?.body ?? '';
      setBody(latestBody);
      bodyHistory.current = [latestBody];
      bodyHistoryIndex.current = 0;
      setViewedVersionId(null);
      setMessage(detail ? '' : '项目不存在或已被删除');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);
  useEffect(() => {
    const requestImport = () => importInput.current?.click(); window.addEventListener('studio-import-request', requestImport);
    return () => window.removeEventListener('studio-import-request', requestImport);
  }, []);
  useEffect(() => {
    void loadFirst();
  }, [query, status, archived, order, platform, offset]);
  useEffect(() => {
    return window.wmb.onDataChanged((event) => {
      const scopes = event.scopes ?? [];
      const touchesStudio = scopes.includes('studio') || scopes.includes('agent') || scopes.length === 0;
      if (!touchesStudio) return;
      void loadFirst(true);
      // Pi may save while this project is open; never replace any local core/platform draft.
      if (selectedId && !anyDirty) {
        if (!event.reason?.split(',').every((reason) => reason.startsWith('studio_annotations.'))) pendingExternalReplaceRef.current = true;
        void loadDetail(selectedId);
      }
    });
  }, [query, status, archived, order, platform, offset, anyDirty, selectedId, busy]);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const loadIllustrations = async () => {
      if (!selectedId) { if (live) setIllustrationRuns([]); return; }
      const [runs, config] = await Promise.all([
        window.wmb.listIllustrationRuns(selectedId).catch(() => [] as IllustrationRun[]),
        window.wmb.getIllustrationImageConfig().catch(() => null)
      ]);
      if (!live) return;
      setIllustrationRuns(runs ?? []);
      if (config) { setIllustrationProfileId(config.profileId); setIllustrationImageModel(config.model); }
      if (runs?.some((run) => ['pending', 'planning', 'running'].includes(run.status))) timer = window.setTimeout(loadIllustrations, 1200);
    };
    void loadIllustrations();
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [selectedId, selected?.revisions[0]?.id]);
  useEffect(()=>{void window.wmb.listKnowledgeTopics({limit:100}).then((page)=>setTopics(page?.items ?? []));},[]);
  useEffect(() => { setOffset(0); }, [query, status, archived, order, platform]);
  useEffect(() => { if (!selectedId) { setSelected(null); setPlatformSelections({}); setPlatformDrafts({}); setInvestigationIndicator(studioInvestigationIndicator(null)); onContext(null); } }, [selectedId]);
  const summary = projects.find((item) => item.id === selectedId);
  useEffect(() => {
    if (!selectedId) return;
    if (anyDirty && selected?.id === selectedId) return;
    if (!selected || selected.id !== selectedId || selected.updatedAt !== summary?.updatedAt) void loadDetail(selectedId);
  }, [selectedId, summary?.updatedAt, anyDirty, selected?.id, selected?.updatedAt]);
  useEffect(() => { onContext(selected ? { id: selected.id, title: selected.title } : null); }, [selected?.id, selected?.title]);
  useEffect(() => {
    if (!onFocusChange) return;
    if (selected) {
      const latestBody = selected.revisions[0]?.body ?? '';
      const excerpt = latestBody.trim() ? latestBody.slice(0, 6000) : null;
      const rowsCurrent = annotationScopeKeyValue !== '' && rowsScopeKeyRef.current === annotationScopeKeyValue;
      onFocusChange({
        type: 'project',
        id: selected.id,
        title: selected.title,
        summary: `状态 ${selected.status} · ${selected.revisions.length} 版`,
        bodyStatus: excerpt ? 'ready' : 'empty',
        bodyExcerpt: excerpt,
        bodyChars: excerpt?.length ?? 0,
        studioDocument: annotationScope ? {
          projectId: selected.id,
          documentKind: annotationScope.documentKind,
          documentId: annotationScope.documentId,
          platform: annotationScope.platform,
          title: editorTitle,
          currentBody: editorBody,
          bodyFingerprint: computeBodyFingerprint(editorBody),
          dirty
        } : undefined,
        openAnnotations: rowsCurrent ? openAnnotationRows.map((row) => {
          const context = annotationContextAround(editorBody, row.startOffset, row.endOffset);
          return {
            id: row.id,
            startOffset: row.startOffset,
            endOffset: row.endOffset,
            quotedText: row.quotedText,
            prefixContext: context.prefixContext,
            suffixContext: context.suffixContext,
            note: row.note
          };
        }) : []
      });
      return;
    }
    if (listFocusId) {
      const project = projects.find((item) => item.id === listFocusId);
      if (project) {
        onFocusChange({
          type: 'project',
          id: project.id,
          title: project.title,
          summary: `${project.archivedAt ? '已归档' : project.status} · ${project.versionCount} 版 · 列表焦点（未打开编辑器）`,
          bodyStatus: 'none',
          bodyExcerpt: null,
          bodyChars: 0
        });
        return;
      }
    }
    onFocusChange(null);
  }, [selected?.id, selected?.title, selected?.status, selected?.revisions[0]?.id, listFocusId, projects, onFocusChange, editorBody, editorTitle, dirty, annotationScopeKeyValue, openAnnotationRows]);
  useEffect(() => {
    setPlatformSelections({});
    setPlatformDrafts({});
  }, [selected?.id]);
  useEffect(() => {
    setTitle(selected?.title ?? '');
    const latestBody = selected?.revisions[0]?.body ?? '';
    setBody(latestBody);
    bodyHistory.current = [latestBody];
    bodyHistoryIndex.current = 0;
    setViewedVersionId(null);
    setCopyTitle(selected ? `${selected.title}（独立项目）` : '');
  }, [selected?.id, selected?.title, selected?.revisions[0]?.id]);
  // WMB-5237 核心媒体草稿：随项目/最新核心版本初始化（保存后回读一致）；切 tab/切版本不丢（状态常驻）。
  useEffect(() => {
    const bindings = coreBindingsFromDetail(selected);
    setCoreMediaDraft(bindings);
    setCoreMediaBase(bindings);
  }, [selected?.id, selected?.revisions[0]?.id]);
  const readOnlyVersion = tab === 'versions' ? viewedVersion : null;
  const annotationsEditable = Boolean(selected && annotationScope && !readOnlyVersion && !busy);
  // ---- WMB-5207 正文批注：当前 scope 加载（保留 dirty draft）----
  useEffect(() => {
    if (!annotationScope) {
      rowsScopeKeyRef.current = '';
      setAnnotationRows([]);
      setAnnotationsLoading(false);
      setAnnotationsError(null);
      return;
    }
    const scopeKey = annotationScopeKey(annotationScope);
    let cancelled = false;
    setAnnotationsLoading(true);
    setAnnotationsError(null);
    window.wmb.listStudioAnnotations({ ...annotationScope, includeResolved: true })
      .then((rows) => {
        if (cancelled) return;
        setAnnotationRows(rows);
        rowsScopeKeyRef.current = scopeKey;
        backendBodyRef.current = editorBody;
        annotationBasisRef.current = editorBody;
      })
      .catch((error) => { if (!cancelled) setAnnotationsError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setAnnotationsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationScopeKeyValue, annotationReloadTick]);
  // 装饰收敛：把本地 rows 迁移到当前模式的基础文本（source=editorBody；rich=标题前缀+渲染正文）
  const currentAnnotationBasis = (): string | null => {
    const editor = bodyInput.current;
    if (!editor || editorMode === 'source') return editorBody;
    return editorBody.slice(0, annotationLeadingTitleLen) + richMapping(editor).canonical;
  };
  useEffect(() => {
    if (!annotationScope || rowsScopeKeyRef.current !== annotationScopeKeyValue) return;
    if (pendingExternalReplaceRef.current) return;
    const basis = currentAnnotationBasis();
    if (basis === null || annotationBasisRef.current === basis) return;
    const previous = annotationBasisRef.current;
    setAnnotationRows((rows) => shiftAnnotationRanges(rows, previous, basis));
    annotationBasisRef.current = basis;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorBody, editorMode, annotationScopeKeyValue, annotationRows]);
  const syncAnnotationsToBody = async (
    scope: StudioDocumentScope,
    scopeKey: string,
    nextBody: string,
    mode: 'incremental' | 'replacement'
  ): Promise<boolean> => {
    window.clearTimeout(reconcileTimer.current);
    const pending = annotationSyncPromiseRef.current;
    if (pending) await pending;
    if (rowsScopeKeyRef.current !== scopeKey || backendBodyRef.current === nextBody) return true;
    const previousBody = backendBodyRef.current;
    const guard = ++annotationSyncGuardRef.current;
    const request = window.wmb.reconcileStudioAnnotations({ ...scope, previousBody, nextBody, mode })
      .then((result) => {
        if (!result.ok || guard !== annotationSyncGuardRef.current) return false;
        setAnnotationRows(result.data);
        rowsScopeKeyRef.current = scopeKey;
        backendBodyRef.current = nextBody;
        return true;
      })
      .catch(() => false);
    annotationSyncPromiseRef.current = request;
    const synced = await request;
    if (annotationSyncPromiseRef.current === request) annotationSyncPromiseRef.current = null;
    return synced;
  };

  // 权威同步：本地编辑后 600ms 防抖增量 reconcile；外部替换走 replacement 路径
  useEffect(() => {
    const replace = pendingExternalReplaceRef.current;
    pendingExternalReplaceRef.current = false;
    if (!annotationScope || rowsScopeKeyRef.current !== annotationScopeKeyValue) return;
    if (backendBodyRef.current === editorBody) return;
    const scope = annotationScope;
    const scopeKey = annotationScopeKeyValue;
    if (replace) {
      void syncAnnotationsToBody(scope, scopeKey, editorBody, 'replacement');
      return;
    }
    window.clearTimeout(reconcileTimer.current);
    reconcileTimer.current = window.setTimeout(() => {
      if (busy || !selected) return;
      void syncAnnotationsToBody(scope, scopeKey, editorBody, 'incremental');
    }, 600);
    return () => window.clearTimeout(reconcileTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorBody, busy, annotationScopeKeyValue]);
  useEffect(() => () => window.clearTimeout(reconcileTimer.current), []);
  const outline = useMemo(() => bodyWithoutLeadingTitle(editorBody).split('\n').flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], index }] : [];
  }), [editorBody]);
  const characterCount = editorBody.replace(/\s/g, '').length; const displayBody = readOnlyVersion?.body ?? editorBody;
  const editorTab = tab === 'core' || tab === 'versions' || Boolean(activePlatform);
  // WMB-5237 本文图片：只投影当前版本正文中的 wmb-asset 图片（含只读历史版本）。
  const assetImageRefs = useMemo(() => parseAssetImages(displayBody), [displayBody]);
  const assetById = useMemo(() => new Map((selected?.assets ?? []).map((asset) => [asset.id, asset])), [selected?.assets]);
  // WMB-5237 平台媒体投影：正文引用 ↔ 平台绑定（封面/序/裁剪/平台图注），发布序展示。
  const platformSyncedBindings = useMemo(() => {
    if (!activePlatform) return [] as PlatformMediaBindingDraft[];
    const base = activePlatformDraft?.mediaBindings ?? platformBindingsToDrafts(readPlatformVersionBindings(activePlatformVersion));
    return syncPlatformBindingsToRefs(base, parseAssetImages(editorBody));
  }, [activePlatform, activePlatformDraft?.mediaBindings, activePlatformVersion, editorBody]);
  const platformDisplayBindings = useMemo(() => [...platformSyncedBindings].sort((a, b) => a.ordinal - b.ordinal), [platformSyncedBindings]);
  // 变更入口统一基于草稿绑定（正文序数组；无草稿时用投影推导，保持顺序语义一致）。
  const currentPlatformBindings = activePlatformDraft?.mediaBindings ?? platformSyncedBindings;
  // ---- WMB-5237 正文内图片：布局投影（只写 figure data 属性，绝不写正文 token / 批注偏移）----
  // 核心 tab：投影 coreMediaDraft；只读历史：投影所看版本读模型绑定；平台 tab：无布局字段不投影。
  const mediaLayoutMap = useMemo(() => contentMediaLayoutMap(coreMediaDraft), [coreMediaDraft]);
  const viewedLayoutMap = useMemo(() => contentMediaLayoutMap(((viewedVersion as { bindings?: ContentMediaBinding[] } | null)?.bindings) ?? []), [viewedVersion]);
  const emptyLayoutMap = useMemo(() => new Map<string, { widthPreset: MediaWidthPreset; align: MediaAlign }>(), []);
  const activeLayoutMap = activePlatform ? emptyLayoutMap : (readOnlyVersion ? viewedLayoutMap : mediaLayoutMap);
  const applyInlineLayout = useCallback((root: HTMLElement) => {
    const seenCounts = new Map<string, number>();
    for (const figure of root.querySelectorAll<HTMLElement>('figure.studio-figure')) {
      const assetId = figure.getAttribute('data-wmb-asset') ?? '';
      if (!assetId) continue;
      // 优先读 renderer 写入的 occurrence 属性；旧 DOM（无属性）回退到同 assetId 出现序。
      const attrOccurrence = figure.getAttribute('data-wmb-occurrence');
      const occurrence = attrOccurrence !== null ? Number(attrOccurrence) : (seenCounts.get(assetId) ?? 0);
      if (attrOccurrence === null) seenCounts.set(assetId, occurrence + 1);
      const layout = activeLayoutMap.get(contentBindingKey(assetId, occurrence));
      if (layout) {
        figure.setAttribute('data-wmb-width', layout.widthPreset);
        figure.setAttribute('data-wmb-align', layout.align);
      } else {
        figure.removeAttribute('data-wmb-width');
        figure.removeAttribute('data-wmb-align');
      }
      figure.draggable = editorMode === 'rich' && !readOnlyVersion && !busy;
      if (figure.draggable) figure.title = '拖动图片调整位置';
      else figure.removeAttribute('title');
    }
  }, [activeLayoutMap, editorMode, readOnlyVersion, busy]);
  // 布局草稿 / 正文变化后重新投影（可视化编辑器与只读历史共用）。
  useEffect(() => {
    if (!editorTab || !bodyInput.current) return;
    applyInlineLayout(bodyInput.current);
  }, [editorTab, displayBody, editorMode, readOnlyVersion?.id, applyInlineLayout]);
  // 富文本 DOM 唯一的回填路径：正在输入时保光标（activeElement + richDomSynced 守卫），
  // 模式/页签/历史切换、撤销重做与外部改写（DOM 未反映 editorBody）时从 displayBody 重渲染。
  // 注意：不得再加无守卫的 innerHTML 写入 —— 每次击键都会重建子树并丢失光标/输入法组合。
  useEffect(() => {
    if (!editorTab) return;
    if (editorMode !== 'rich' && !readOnlyVersion) return;
    const editor = bodyInput.current;
    if (!editor) return;
    if (document.activeElement === editor && editorMode === 'rich' && !readOnlyVersion && richDomSyncedRef.current) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
    applyInlineLayout(editor);
  }, [tab, editorTab, displayBody, readOnlyVersion?.id, editorMode]);
  const fitSourceEditor = () => {
    const textarea = sourceInput.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const minHeight = Math.max(window.innerHeight - 360, 420);
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  };
  useEffect(() => {
    if (!editorTab) return;
    if (editorMode !== 'source' || readOnlyVersion) return;
    const id = window.requestAnimationFrame(() => fitSourceEditor());
    return () => window.cancelAnimationFrame(id);
  }, [tab, editorBody, editorMode, readOnlyVersion]);
  useEffect(() => {
    bodyHistory.current = [editorBody];
    bodyHistoryIndex.current = 0;
  }, [selected?.id, tab, activePlatformVersion?.id]);
  const updateActivePlatformDraft = (change: Partial<{ title: string; body: string; assetIds: string[]; mediaBindings: PlatformMediaBindingDraft[] }>) => {
    if (!activePlatformDraftKey) return;
    setPlatformDrafts((current) => {
      const previous = current[activePlatformDraftKey] ?? createStudioPlatformDraft(activePlatformVersion);
      return { ...current, [activePlatformDraftKey]: { ...previous, ...change } };
    });
  };
  const applyEditorBody = (next: string) => {
    if (activePlatform) {
      updateActivePlatformDraft({ body: next });
      syncPlatformBindingsForBody(next);
    } else {
      setBody(next);
    }
  };
  const changeEditorTitle = (next: string) => activePlatform ? updateActivePlatformDraft({ title: next }) : setTitle(next);
  const changeBody = (next: string) => {
    // 默认视为外部改写（富文本 DOM 需回填）；编辑器 DOM 路径在调用后自行置回 true。
    richDomSyncedRef.current = false;
    const history = bodyHistory.current.slice(0, bodyHistoryIndex.current + 1);
    if (history[history.length - 1] !== next) history.push(next);
    bodyHistory.current = history;
    bodyHistoryIndex.current = history.length - 1;
    applyEditorBody(next);
  };
  const handleEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (readOnlyVersion || busy) return;
    const editor = bodyInput.current;
    if (!editor) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (file) {
      event.preventDefault();
      void insertImageFile(file);
      return;
    }
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    if (html && !looksLikeMarkdown(text)) return;
    if (!text || !looksLikeMarkdown(text)) return;
    event.preventDefault();
    document.execCommand('insertHTML', false, renderMarkdown(text));
    changeBody(htmlToMarkdown(editor));
    richDomSyncedRef.current = true;
  };
  const handleSourcePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnlyVersion || busy) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void insertImageFile(file);
  };
  const insertImageFile = async (file?: File) => {
    if (!selected || busy || readOnlyVersion) return;
    const sourceStart = sourceInput.current?.selectionStart ?? editorBody.length;
    const insertionBookmark: EditorInsertionBookmark = editorMode === 'source'
      ? {
          body: editorBody,
          offset: sourceStart,
          sourceSelection: {
            start: sourceStart,
            end: sourceInput.current?.selectionEnd ?? sourceStart
          }
        }
      : bodyInput.current
        ? captureRichInsertionBookmark(bodyInput.current, editorBody)
        : { body: editorBody, offset: editorBody.length };
    setBusy(true);
    setMessage(file ? '正在插入图片…' : '选择图片…');
    try {
      const result = file
        ? await (async () => {
            const buffer = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (const byte of buffer) binary += String.fromCharCode(byte);
            return window.wmb.importStudioImage({
              projectId: selected.id,
              fileName: file.name,
              mimeType: file.type,
              bytesBase64: btoa(binary),
              alt: file.name.replace(/\.[^.]+$/, '')
            });
          })()
        : await window.wmb.importStudioImage({ projectId: selected.id });
      if (!result.ok) {
        setMessage(result.cancelled ? '' : '插入图片失败');
        return;
      }
      if (activePlatform) updateActivePlatformDraft({ assetIds: [...new Set([...(activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? []), result.asset.id])] });
      const start = insertionBookmark.sourceSelection?.start ?? insertionBookmark.offset;
      const end = insertionBookmark.sourceSelection?.end ?? start;
      const before = insertionBookmark.body.slice(0, start);
      const after = insertionBookmark.body.slice(end);
      const leadingBreak = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const trailingBreak = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      const snippet = `${leadingBreak}${result.markdown}${trailingBreak}`;
      changeBody(`${before}${snippet}${after}`);
      setMessage(result.reused ? '已插入已有图片素材' : '图片已插入');
      const detail = await window.wmb.getStudioProject(selected.id); if (detail) setSelected(detail);
      if (editorMode === 'source') {
        const caret = start + snippet.length;
        window.requestAnimationFrame(() => {
          const textarea = sourceInput.current;
          if (!textarea) return;
          textarea.focus();
          textarea.setSelectionRange(caret, caret);
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (imageInput.current) imageInput.current.value = '';
    }
  };
  const { moveHistory, insertMarkdown, formatSelection, execRich } = useStudioEditorOps({
    selected, busy, readOnlyVersion, editorMode, editorBody, changeBody, bodyInput, sourceInput, richDomSyncedRef, bodyHistory, bodyHistoryIndex, applyEditorBody, insertImageFile
  });
  // ---- WMB-5237 本文图片菜单：定位 / 替换 / 编辑图注 / 移出（只投影当前正文，走 changeBody）----
  // WMB-5237 平台绑定对账：正文引用 ↔ 绑定（封面/序/裁剪/平台图注元数据保留），并重建 assetIds 投影。
  const syncPlatformBindingsForBody = (nextBody: string) => {
    if (!activePlatform) return;
    const refs = parseAssetImages(nextBody);
    const base = activePlatformDraft?.mediaBindings ?? platformBindingsToDrafts(readPlatformVersionBindings(activePlatformVersion));
    const mediaBindings = syncPlatformBindingsToRefs(base, refs);
    const assetIds = buildAssetIdsFromPlatformBindings(mediaBindings);
    const current = activePlatformDraft;
    const idsChanged = !current || current.assetIds.length !== assetIds.length || current.assetIds.some((id, index) => id !== assetIds[index]);
    if (!current || idsChanged || !platformMediaBindingsEqual(current.mediaBindings, mediaBindings)) {
      updateActivePlatformDraft({ mediaBindings, assetIds });
    }
  };
  const closeImageMenu = () => {
    setImageMenuOpen(false);
    setImageMenuRect(null);
    setImageMenuEditKey(null);
    setImageMenuAltDrafts({});
    setImageMenuBusyIndex(null);
    setVideoClipEdit(null);
  };
  const openImageMenu = () => {
    if (assetImageRefs.length === 0 && (selected?.sourceMedia.length ?? 0) === 0 && mediaRecommendations == null) return;
    const rect = imageMenuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(760, window.innerWidth - 24);
    setImageMenuRect({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
      width
    });
    setImageMenuEditKey(null);
    setImageMenuAltDrafts({});
    setImageMenuOpen(true);
  };
  const { loadRecommendations, posterCandidatesForAsset, generateRecommendations, acceptRecommendation, rejectRecommendation, seekStudioVideo, startVideoClipEdit, saveVideoClipEdit, cycleVideoPoster } = useStudioRecommendations({
    selected, busy, readOnlyVersion, activePlatform, currentPlatformBindings, assetImageRefs, editorBody, changeBody, updateActivePlatformDraft, insertMarkdown, setMessage, setMediaRecommendations, setRecommendationsLoading, setRecommendationsGenerating, mediaRecommendations, recommendationsLoading, recommendationsGenerating, videoClipEdit, setVideoClipEdit
  } as unknown as never);
  useEffect(() => {
    if (!imageMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeImageMenu(); };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (imageMenuRef.current?.contains(target)) return;
      if (imageMenuButtonRef.current?.contains(target)) return;
      closeImageMenu();
    };
    const handleViewportChange = () => closeImageMenu();
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageMenuOpen]);
  // WMB-5237 内联工具栏「裁剪」入口：监听 studio-inline-crop-request，按 assetId+occurrence 打开裁切对话框
  useEffect(() => {
    const onInlineCropRequest = (event: Event) => {
      if (readOnlyVersion || busy) return;
      const detail = (event as CustomEvent<{ assetId?: unknown; occurrence?: unknown }>).detail;
      if (!detail || typeof detail.assetId !== 'string') return;
      const occurrence = typeof detail.occurrence === 'number' ? detail.occurrence : 0;
      const ref = assetImageRefs.find((item) => item.assetId === detail.assetId && item.occurrence === occurrence);
      if (!ref) { setMessage('找不到要裁剪的图片'); return; }
      openCropAssetImage(ref);
    };
    window.addEventListener('studio-inline-crop-request', onInlineCropRequest);
    return () => window.removeEventListener('studio-inline-crop-request', onInlineCropRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetImageRefs, readOnlyVersion, busy]);
  // keep test strings for moved image handlers – replaceAssetImageToken removeAssetImageToken updateAssetImageAlt window.wmb.importStudioImage parseAssetImages assetImageToken (studio-view-image-handlers.tsx)
  const { locateAssetImage, requestReplaceAssetImage, replaceAssetImage, removeAssetImage, startCaptionEdit, saveCaptionEdit, removePlatformAsset, openCropAssetImage, deriveCropAsset, applyCropResult } = useStudioImageHandlers({
    selected, busy, readOnlyVersion, editorBody, changeBody, syncPlatformBindingsForBody, assetImageRefs, assetById, editorMode, sourceInput, bodyInput, canvasRef, imageMenuButtonRef, imageMenuRef, replaceImageInput, pendingReplaceRef, imageMenuOpen, setImageMenuOpen, imageMenuRect, setImageMenuRect, imageMenuEditKey, setImageMenuEditKey, imageMenuAltDrafts, setImageMenuAltDrafts, imageMenuBusyIndex, setImageMenuBusyIndex, activePlatform, currentPlatformBindings, setPlatformCropPayloads, updateActivePlatformDraft, setMessage, setSelected, setCropTarget
  } as unknown as never);
  const {
    findInlineFigure, handleInlineFigureClick,
    handleInlineFigureDragStart, handleInlineFigureDragOver, handleInlineFigureDrop, handleInlineFigureDragEnd,
    moveInlineFigure,
    inlineDraft, inlineAlt, canMoveInlineUp, canMoveInlineDown,
    handleInlineWidth, handleInlineAlign, handleInlineReplace, handleInlineCaption, handleInlineRemove, handleInlineCrop
  } = useStudioInlineImages({
    selected, coreMediaDraft, setCoreMediaDraft, editorBody, displayBody, changeBody, activePlatform,
    assetImageRefs, bodyInput, canvasRef, readOnlyVersion, busy, cropTarget, editorMode, richDomSyncedRef, setMessage,
    requestReplaceAssetImage, removeAssetImage, inlineSelection, setInlineSelection, draggedFigureRef, dropTargetRef
  });
  const createProject = async () => {
    if (!newTitle.trim() || busy) return;
    setBusy(true);
    try {
      const detail = await window.wmb.createStudioProject({ title: newTitle.trim(), body: '开始写作。' });
      setCreating(false);
      setNewTitle('');
      await loadFirst(true);
      onSelect(detail.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const importProject = async (file: File) => {
    setBusy(true);
    try {
      const body = await file.text();
      const title = file.name.replace(/\.(md|markdown|txt)$/i, '').trim() || '导入稿件';
      const detail = await window.wmb.createStudioProject({ title, body: body.trim() || '开始写作。' });
      await loadFirst(true);
      onSelect(detail.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); if (importInput.current) importInput.current.value = ''; }
  };

  const reload = async () => { if (selectedId) await loadDetail(selectedId); await loadFirst(true); };
  const deleteRow = async (project: ContentProjectSummary) => {
    if (busy) return;
    if (!await appConfirm({ title: '删除项目', message: `彻底删除项目「${project.title}」？此操作不可恢复。`, confirmLabel: '彻底删除', danger: true })) return;
    setBusy(true);
    try {
      const result = await window.wmb.deleteStudioProject({ projectId: project.id, expectedRevision: project.revision });
      setMessage(result.ok ? '项目已彻底删除' : result.error?.message || '删除失败');
      if (result.ok) await loadFirst(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const archiveRow = async (project: ContentProjectSummary) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.wmb.updateStudioProject({ projectId: project.id, expectedRevision: project.revision, archived: !project.archivedAt });
      setMessage(result.ok ? (project.archivedAt ? '已恢复项目' : '已归档项目，可在「已归档」中恢复') : result.error?.message || '操作失败');
      if (result.ok) await loadFirst(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  // keep test strings for moved save – assetIds: activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? [] mediaBindings: savedBindings (studio-view-save.tsx)
  const { save } = useStudioSave({
    selected, busy, readOnlyVersion, editorBody, editorTitle, dirty, activePlatform, activePlatformVersion, activePlatformDraft, activePlatformDraftKey, platformDrafts, setPlatformDrafts, platformCropPayloads, setPlatformCropPayloads, coreMediaDraft, setMessage, setBusy, setPlatformSelections, setSelected, loadFirst, reload, setAnnotationReloadTick, syncAnnotationsToBody, annotationScope, annotationScopeKeyValue, reconcileTimer, selectedId, latest, platformSyncedBindings, currentPlatformBindings
  } as unknown as never);
  const startIllustrationRun = async () => {
    if (!selected || activePlatform || readOnlyVersion || illustrationBusy || !latest) return;
    setIllustrationBusy(true); setMessage('正在固定正文并开始配图…');
    try {
      const result = await window.wmb.startIllustration({
        projectId: selected.id,
        requestId: `studio:illustration:${selected.id}:${latest.id}:${Date.now()}`,
        expectedRevision: selected.revision,
        imageProfileId: illustrationProfileId || undefined,
        imageModel: illustrationImageModel || undefined,
        ratio: illustrationRatio,
        maxGenerated: illustrationMaxGenerated
      });
      if (!result.ok || !result.data) { setMessage(result.error?.message || '配图未启动'); return; }
      setIllustrationRuns((runs) => [result.data!, ...runs.filter((run) => run.id !== result.data!.id)]);
      setMessage('配图运行已开始，成功图片会自动插入新正文版本');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setIllustrationBusy(false); }
  };
  const retryIllustrationItem = async (runId: string, itemId: string) => {
    if (illustrationBusy) return;
    setIllustrationBusy(true);
    try { const result = await window.wmb.retryIllustrationItem({ runId, itemId }); if (result.ok && result.data) setIllustrationRuns((runs) => runs.map((run) => run.id === result.data!.id ? result.data! : run)); else setMessage(result.error?.message || '配图重试失败'); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setIllustrationBusy(false); }
  };
  const regenerateIllustrationItem = async (runId: string, itemId: string) => {
    if (illustrationBusy) return;
    setIllustrationBusy(true);
    try { const result = await window.wmb.regenerateIllustrationItem({ runId, itemId, ratio: illustrationRatio, request: illustrationRequest || undefined }); if (result.ok && result.data) { setIllustrationRuns((runs) => runs.map((run) => run.id === result.data!.id ? result.data! : run)); setIllustrationRequest(''); } else setMessage(result.error?.message || '原位重新生成失败'); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setIllustrationBusy(false); }
  };
  const undoIllustrationItem = async (runId: string, itemId: string) => {
    if (illustrationBusy) return;
    setIllustrationBusy(true);
    try { const result = await window.wmb.undoIllustrationItem({ runId, itemId }); if (result.ok && result.data) setIllustrationRuns((runs) => runs.map((run) => run.id === result.data!.id ? result.data! : run)); else setMessage(result.error?.message || '撤销配图失败'); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setIllustrationBusy(false); }
  };
  const prepareZhihuPublication = async () => {
    if (busy || activePlatform !== 'zhihu' || !activePlatformVersion || dirty) return;
    setBusy(true); setMessage('正在写入知乎编辑器…');
    try {
      const result = await window.wmb.prepareZhihuArticlePublication(activePlatformVersion.id);
      if (!result.ok) {
        setMessage(result.error?.message || '知乎编辑器准备失败');
        return;
      }
      setMessage('已写入知乎编辑器，等待人工确认发布');
      openPublish();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const writeDraft = async () => {
    if (!selected || busy) return;
    setBusy(true); setMessage('Pi 正在写初稿…');
    try {
      const result = await window.wmb.startStudioDraft({ businessDate: planDate, projectId: selected.id });
      const task = result.data?.task;
      setMessage(result.ok
        ? task?.phase === 'research_dispatched'
          ? '已派外部研究，完成后将自动续写'
          : task?.status === 'failed'
            ? task.errorMessage || '外部研究未成功派出'
            : task?.status === 'needs_user'
              ? task.errorMessage || '需要用户处理'
              : 'Pi 初稿任务已完成'
        : result.error?.message || '初稿失败');
      await reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const update = async (change: { status?: ContentProjectStatus; archived?: boolean; topicId?:string|null }) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await window.wmb.updateStudioProject({ projectId: selected.id, expectedRevision: selected.revision, ...change });
      if (result.ok) {
        setSelected(result.data);
        setMessage(change.archived === true ? '已归档' : change.archived === false ? '已恢复' : change.topicId!==undefined?'长期主题已更新':'工作状态已更新');
        await loadFirst();
      } else {
        setMessage(result.error?.code === 'REVISION_CONFLICT' ? '项目已在其他位置更新，已读取最新状态' : result.error?.message || '项目更新失败');
        setSelected(result.error?.details?.current ?? null);
        if (!result.error?.details?.current) await reload();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const saveFromVersion = async () => {
    if (!selected || !viewedVersion || busy) return;
    setBusy(true); setMessage(`正在基于 v${viewedVersion.number} 另存…`);
    try {
      const result = await window.wmb.saveStudioCore({
        projectId: selected.id, title: selected.title, body: viewedVersion.body, expectedRevision: selected.revision
      });
      if (!result.ok) setMessage(result.error?.code === 'REVISION_CONFLICT' ? '项目已更新，请读取最新版后重试' : result.error?.message || '另存失败');
      else { setMessage(`已基于 v${viewedVersion.number} 新增一个版本`); await reload(); setViewedVersionId(null); setAnnotationReloadTick((tick) => tick + 1); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const copyVersion = async () => {
    if (!selected || !viewedVersion || busy) return;
    setBusy(true); setMessage(`正在复制 v${viewedVersion.number}…`);
    try {
      const result = await window.wmb.copyStudioVersionToProject({
        sourceProjectId: selected.id, contentVersionId: viewedVersion.id, title: copyTitle
      });
      if (!result.ok || !result.data) setMessage(result.error?.message || '复制失败');
      else {
        setProjects((current) => [result.data!, ...current.filter((item) => item.id !== result.data!.id)]);
        onSelect(result.data.id);
        setMessage(`已创建独立项目：${result.data.title}`);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  // ---- WMB-5207 正文批注：选区捕获 / 创建 / 说明 / 移除 / 重开 / 双向定位 ----
  const reloadAnnotations = () => setAnnotationReloadTick((tick) => tick + 1);
  const { readCurrentSelection, createAnnotationAt, updateAnnotationNote, removeAnnotation, reopenAnnotation, selectAnnotationFromBody, locateAnnotation, markSelection, openAnnotationMenu, handleEditorContextMenu } = useStudioAnnotations({
    selected, annotationScope, annotationScopeKeyValue, readOnlyVersion, busy, annotationBusy, setAnnotationBusy, openAnnotationRows, setAnnotationRows, rowsScopeKeyRef, reconcileTimer, backendBodyRef, setContextPanelTab, setSelectedAnnotationId, setFlashAnnotationId, setHistoryOpen, setAnnotationMenu, setMessage, reloadAnnotations, editorBody, annotationLeadingTitleLen, bodyInput, sourceInput, editorMode, annotationsEditable, sourceHitTestRef, annotationRows, setAnnotationReloadTick
  } as unknown as never);

  const confirmNoteInput = async (note: string) => {
    const input = noteInput;
    if (!input) return;
    if (input.mode === 'create') await createAnnotationAt(input.snapshot, note);
    else await updateAnnotationNote(input.annotationId, note);
    setNoteInput(null);
  };

  const discussAnnotationsWithPi = () => {
    if (!openAnnotationRows.length) return;
    window.dispatchEvent(new CustomEvent('studio-discuss-pi', { detail: { projectId: selected?.id, annotationCount: openAnnotationRows.length } }));
  };

  const annotationMenuItems = useMemo<Array<{ id: string; label: string; onSelect: () => void; disabled?: boolean }>>(() => {
    if (!annotationMenu) return [];
    if (annotationMenu.kind === 'create') {
      return [
        { id: 'mark', label: '标记为有问题', onSelect: () => { void createAnnotationAt(annotationMenu.snapshot, null); } },
        { id: 'mark-note', label: '标记并说明…', onSelect: () => setNoteInput({ x: annotationMenu.x + 10, y: annotationMenu.y + 10, mode: 'create', snapshot: annotationMenu.snapshot }) }
      ];
    }
    const row = annotationRows.find((item) => item.id === annotationMenu.annotationId);
    return [
      { id: 'edit-note', label: row?.note ? '编辑说明…' : '添加说明…', onSelect: () => setNoteInput({ x: annotationMenu.x + 10, y: annotationMenu.y + 10, mode: 'edit', annotationId: annotationMenu.annotationId, initial: row?.note ?? '' }) },
      { id: 'remove', label: '移除标记', onSelect: () => { void removeAnnotation(annotationMenu.annotationId); } }
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationMenu, annotationRows]);


  const jumpToStart = () => {
    const canvas = canvasRef.current;
    if (canvas) canvas.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const jumpToHeading = (item: { level: number; title: string; index: number }) => {
    // 确保在核心正文页；DOM 可能下帧才挂上
    const run = () => {
      const canvas = canvasRef.current;
      const title = item.title.trim();
      // 可视化编辑 / 只读历史：按标题文本定位
      const root = bodyInput.current;
      if (root) {
        const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        const hit = headings.find((node) => (node.textContent || '').trim() === title)
          ?? headings.find((node) => (node.textContent || '').trim().includes(title));
        if (hit) {
          hit.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
      // 源码模式：按纲要行号估算滚动
      const ta = sourceInput.current;
      if (ta && canvas) {
        const lines = bodyWithoutLeadingTitle(editorBody).split('\n');
        const ratio = lines.length ? Math.min(1, Math.max(0, item.index / lines.length)) : 0;
        const top = Math.max(0, (ta.scrollHeight - ta.clientHeight) * ratio);
        ta.focus();
        ta.scrollTop = top;
        // 同步画布，避免外层仍停在顶部
        canvas.scrollTo({ top: Math.max(0, ta.offsetTop - 24), behavior: 'smooth' });
        // 尝试选中标题行
        const lineStart = lines.slice(0, item.index).join('\n').length + (item.index > 0 ? 1 : 0);
        const lineText = lines[item.index] ?? '';
        try { ta.setSelectionRange(lineStart, lineStart + lineText.length); } catch { /* */ }
      }
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(run));
  };

  if (!selectedId) {
    return <section className="studio-library">
    <input ref={importInput} className="studio-import-input" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProject(file); }}/>
    <input ref={imageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImageFile(file); }}/>
    <StudioLibraryHeader summary={statusSummary} projects={projects} hasMore={hasMore} status={status} archived={archived} setStatus={setStatus} setArchived={setArchived} creating={creating} onCreate={() => setCreating(true)}/>
    <StudioLibraryView summary={statusSummary} projects={projects} hasMore={hasMore} status={status} archived={archived} setStatus={setStatus} setArchived={setArchived} creating={creating} setCreating={setCreating} newTitle={newTitle} setNewTitle={setNewTitle} createProject={createProject} busy={busy} queryDraft={queryDraft} setQueryDraft={setQueryDraft} order={order} setOrder={setOrder} platform={platform} setPlatform={setPlatform} enabledPlatforms={enabledPlatforms} listFocusId={listFocusId} setListFocusId={setListFocusId} onSelect={onSelect} archiveRow={archiveRow} deleteRow={deleteRow} loading={loading} offset={offset} setOffset={setOffset} />
  </section>;
  }

  return <section className="studio-editor-view">
    <input ref={imageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImageFile(file); }}/>
    <input ref={replaceImageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void replaceAssetImage(file); }}/>
    <StudioEditorTop selected={selected} dirty={dirty} latestCreatedAt={activePlatformVersion?.updatedAt ?? latest?.createdAt} documentLabel={activePlatform ? `${platformNames[activePlatform]} · ${activePlatformVersion ? `版本 ${activePlatformVersion.revision}` : '新版本'}` : undefined} onBack={() => onSelect(null)} onToggleHistory={() => setHistoryOpen((value) => !value)} historyOpen={historyOpen} viewedVersion={Boolean(readOnlyVersion)} editorMode={editorMode} setEditorMode={setEditorMode} busy={busy} save={save} preparePublication={activePlatform === 'zhihu' && activePlatformVersion ? prepareZhihuPublication : undefined} prepareLabel="准备发布知乎" prepareDisabled={dirty}/>
    <div className="studio-editor-grid">
    <StudioOutline outline={outline} tab={tab} setTab={setTab} platformVersions={selected?.platformVersions ?? {}} investigationIndicator={investigationIndicator} onJumpToStart={jumpToStart} onJumpToHeading={jumpToHeading}/>
    <main className="studio-document">
      {selected ? <>
        {editorTab && <>
          {readOnlyVersion && <section className="historical-version-notice" aria-label="历史版本">
            <div className="historical-version-strip">
              <span className="historical-version-identity"><b>历史版本 v{readOnlyVersion.number}</b> · 只读</span>
              <div className="historical-version-actions">
                <button type="button" className="primary-button" onClick={() => { setViewedVersionId(null); setCopyOpen(false); }}>返回最新版</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void saveFromVersion()}>基于此版本另存</button>
                <button type="button" className="secondary-button" aria-expanded={copyOpen} onClick={() => setCopyOpen((value) => !value)}>复制为新项目…</button>
              </div>
            </div>
            {copyOpen && <div className="historical-copy-row">
              <label htmlFor="studio-copy-title">新项目标题</label>
              <input id="studio-copy-title" className="studio-copy-title-input" value={copyTitle} placeholder="输入新项目标题" onChange={(event) => setCopyTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && copyTitle.trim() && !busy) void copyVersion(); }}/>
              <button type="button" className="secondary-button" disabled={busy || !copyTitle.trim()} onClick={() => void copyVersion()}>创建新项目</button>
              <button type="button" className="secondary-button" onClick={() => setCopyOpen(false)}>取消</button>
            </div>}
          </section>}
          {!readOnlyVersion && <StudioFormatBar
            busy={busy}
            execRich={execRich}
            formatSelection={formatSelection}
            insertMarkdown={insertMarkdown}
            insertImageFile={insertImageFile}
            toggleFind={() => setFindOpen((value) => !value)}
            onMarkSelection={() => { void markSelection(); }}
            canMark={annotationsEditable}
            illustrationTools={!activePlatform ? <span className="studio-formatbar-group studio-formatbar-illustration" role="group" aria-label="定稿配图">
              <label><span>比例</span><select aria-label="比例" value={illustrationRatio} onChange={(event) => setIllustrationRatio(event.target.value as IllustrationRatio)}>{(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'] as IllustrationRatio[]).map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}</select></label>
              <label><span>张数</span><input aria-label="生成张数" type="number" min={0} max={6} value={illustrationMaxGenerated} onChange={(event) => setIllustrationMaxGenerated(Math.min(6, Math.max(0, Number(event.target.value) || 0)))} /></label>
              <button type="button" className="studio-illustration-start" title="固定当前正文并开始配图" disabled={busy || illustrationBusy || !latest} onClick={() => void startIllustrationRun()}>定稿配图</button>
            </span> : undefined}
          />}
          <StudioIllustrationPanel runs={illustrationRuns} busy={illustrationBusy} ratio={illustrationRatio} setRatio={setIllustrationRatio} maxGenerated={illustrationMaxGenerated} setMaxGenerated={setIllustrationMaxGenerated} request={illustrationRequest} setRequest={setIllustrationRequest} onStart={() => void startIllustrationRun()} onRetry={(runId, itemId) => void retryIllustrationItem(runId, itemId)} onRegenerate={(runId, itemId) => void regenerateIllustrationItem(runId, itemId)} onUndo={(runId, itemId) => void undoIllustrationItem(runId, itemId)} latest={latest} activePlatform={activePlatform} readOnlyVersion={readOnlyVersion} />
          {findOpen && !readOnlyVersion && <div className="studio-findbar"><input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="查找正文"/><input id="studio-replace" placeholder="替换为"/><span>{findText ? editorBody.split(findText).length - 1 : 0} 处匹配</span><button disabled={!findText || !editorBody.includes(findText)} onClick={() => { const replacement = (document.querySelector('#studio-replace') as HTMLInputElement)?.value ?? ''; changeBody(editorBody.split(findText).join(replacement)); }}>全部替换</button><button onClick={() => setFindOpen(false)}>关闭</button></div>}
          <div className="studio-canvas" ref={canvasRef}><article className="studio-paper">
            <textarea id="studio-title" className="studio-title-input" value={editorTitle} rows={1} disabled={busy || Boolean(readOnlyVersion)} placeholder={activePlatform ? '输入平台标题（可选）' : undefined} onChange={(event) => changeEditorTitle(event.target.value)} onInput={(event) => { const el = event.currentTarget; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }} ref={(node) => { if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }}/>
            {readOnlyVersion || editorMode === 'rich' ? (
              <div className="studio-rich-annotate-wrap" ref={richWrapRef}>
                <div
                  ref={(node) => {
                    bodyInput.current = node;
                    // 正在输入时保光标：仅当编辑器 DOM 未反映 editorBody（非输入路径改写）或
                    // 编辑器未聚焦（模式/页签切换、历史只读、外部改写）时回填。
                    // 聚焦输入期间 DOM 即真源，onInput 已同步 editorBody，回填会破坏光标与输入法。
                    if (node && (readOnlyVersion || editorMode === 'rich')
                      && (document.activeElement !== node || !richDomSyncedRef.current)) {
                      const html = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
                      if (node.innerHTML !== html) {
                        node.innerHTML = html;
                        // WMB-5287：回填重建了整个子树，必须同步重投影图片布局，
                        // 否则 blur/选中关闭等与草稿无关的提交会把 data-wmb-width/align 抹掉。
                        applyInlineLayout(node);
                      }
                    }
                  }}
                  id="studio-body"
                  className="studio-rich-editor"
                  contentEditable={!readOnlyVersion && !busy && editorMode === 'rich'}
                  suppressContentEditableWarning
                  onInput={(event) => { changeBody(htmlToMarkdown(event.currentTarget)); richDomSyncedRef.current = true; }}
                  onPaste={handleEditorPaste}
                  onContextMenu={handleEditorContextMenu}
                  onClick={handleInlineFigureClick}
                  onDragStart={handleInlineFigureDragStart}
                  onDragOver={handleInlineFigureDragOver}
                  onDrop={handleInlineFigureDrop}
                  onDragEnd={handleInlineFigureDragEnd}
                  onBlur={(event) => {
                    if (readOnlyVersion || editorMode !== 'rich') return;
                    event.currentTarget.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(editorBody));
                    applyInlineLayout(event.currentTarget);
                  }}
                />
                {!readOnlyVersion && <StudioAnnotationOverlay mode="rich" editorRef={bodyInput} wrapRef={richWrapRef} body={editorBody} leadingTitleLen={annotationLeadingTitleLen} rows={visibleOpenAnnotations} selectedAnnotationId={selectedAnnotationId} flashAnnotationId={flashAnnotationId} onSelectAnnotation={selectAnnotationFromBody} onAnnotationMenu={openAnnotationMenu} />}
              </div>
            ) : (
              <div className="studio-source-stack">
                <div className="studio-source-annotate-wrap" ref={sourceWrapRef}>
                  <textarea
                    ref={sourceInput}
                    id="studio-body-source"
                    className="studio-source-editor"
                    value={editorBody}
                    disabled={busy}
                    spellCheck={false}
                    placeholder={activePlatform ? `在这里写完整${platformNames[activePlatform]}版本。` : "在这里写完整 Markdown。\n\n## 二级标题\n\n正文段落。"}
                    onChange={(event) => {
                      changeBody(event.target.value);
                      const textarea = event.currentTarget;
                      textarea.style.height = 'auto';
                      const minHeight = Math.max(window.innerHeight - 360, 420);
                      textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
                    }}
                    onPaste={handleSourcePaste}
                    onContextMenu={handleEditorContextMenu}
                  />
                  <StudioAnnotationOverlay mode="source" editorRef={bodyInput} wrapRef={sourceWrapRef} body={editorBody} leadingTitleLen={annotationLeadingTitleLen} rows={visibleOpenAnnotations} selectedAnnotationId={selectedAnnotationId} flashAnnotationId={flashAnnotationId} hitTestRef={sourceHitTestRef} onSelectAnnotation={selectAnnotationFromBody} onAnnotationMenu={openAnnotationMenu} />
                </div>
              </div>
            )}
          </article></div>
          <div className="studio-writing-status" data-running={busy ? 'true' : 'false'}>
            <div className="studio-status-left">
              <span className="studio-status-metrics">字数 {characterCount}</span>
              <span className="studio-status-sep" aria-hidden="true">·</span>
              <div className="studio-status-links" aria-label="关联来源与素材">
                <button type="button" className="studio-status-link" title="查看全部关联来源" onClick={() => setTab('sources')}>来源 {selected.sources.length}</button>
                {selected.sources.slice(0, 3).map((source) => (
                  <button type="button" key={source.id} className="studio-status-chip" title={source.title} onClick={() => {
                    if (onOpenSource) onOpenSource(source.id);
                    else if (source.canonicalUrl) void window.wmb.openExternal(source.canonicalUrl);
                    else setTab('sources');
                  }}>{source.title.length > 16 ? source.title.slice(0, 16) + '…' : source.title}</button>
                ))}
                {selected.sources.length > 3 ? <span className="studio-status-more">+{selected.sources.length - 3}</span> : null}
                <span className="studio-status-sep" aria-hidden="true">·</span>
                <button type="button" className="studio-status-link" title="查看关联素材" onClick={() => setTab('assets')}>素材 {selected.assets.length}</button>
                {selected.assets.slice(0, 2).map((asset) => (
                  <button type="button" key={asset.id} className="studio-status-chip" title={asset.relativePath} onClick={() => setTab('assets')}>
                    {(asset.relativePath.split(/[/\\]/).pop() || asset.relativePath).slice(0, 14)}
                  </button>
                ))}
                <span className="studio-status-sep" aria-hidden="true">·</span>
                <button ref={imageMenuButtonRef} type="button" className="studio-status-link" aria-haspopup="menu" aria-expanded={imageMenuOpen} title={assetImageRefs.length ? '查看本文图片：定位、替换、编辑图注、移出' : '当前正文没有图片'} onClick={() => (imageMenuOpen ? closeImageMenu() : openImageMenu())}>本文图片 {assetImageRefs.length} 张</button>
                {(mediaRecommendations != null || selected.sourceMedia.length > 0) && (
                  <button type="button" className="studio-status-link" aria-haspopup="menu" aria-expanded={imageMenuOpen} title="查看创作媒体建议：生成/接受/拒绝（接受后保存版本写入绑定）" onClick={() => (imageMenuOpen ? closeImageMenu() : openImageMenu())}>素材建议 {mediaRecommendations?.counts?.proposed ?? 0} 条{recommendationsLoading ? '…' : ''}</button>
                )}
                {imageMenuOpen && imageMenuRect && (
                  <div ref={imageMenuRef} className="studio-image-menu" aria-label="本文图片与素材建议" style={{ left: imageMenuRect.left, bottom: imageMenuRect.bottom, width: imageMenuRect.width }}>
                    <div className="studio-image-menu-strip">
                    {(activePlatform ? platformDisplayBindings : assetImageRefs).length > 0 && <span className="studio-image-menu-section" role="heading" aria-level={3}>{activePlatform ? '平台发布图序' : '正文图片'}</span>}
                    {activePlatform ? platformDisplayBindings.map((binding, publishIndex) => {
                      const asset = assetById.get(binding.assetId);
                      const firstRef = assetImageRefs.find((item) => item.assetId === binding.assetId);
                      const effectiveCaption = binding.caption ?? firstRef?.alt ?? '';
                      const ref = firstRef ?? { assetId: binding.assetId, occurrence: 0, alt: effectiveCaption, raw: '', start: 0, end: 0, altStart: 0, altEnd: 0 };
                      const key = `${binding.assetId}:${ref.occurrence}`;
                      const editing = imageMenuEditKey === key;
                      const busyCard = firstRef ? imageMenuBusyIndex === assetImageRefs.indexOf(firstRef) : false;
                      const fileName = asset ? (asset.relativePath.split(/[/\\]/).pop() || asset.relativePath) : binding.assetId;
                      const cover = binding.isCover === true;
                      const isFirst = publishIndex === 0;
                      const isLast = publishIndex === platformDisplayBindings.length - 1;
                      const isVideo = binding.mediaKind === 'video';
                      const posterCandidates = isVideo ? posterCandidatesForAsset(binding.assetId) : [];
                      const posterIndex = isVideo ? posterCandidates.findIndex((candidate) => candidate.assetId === binding.posterAssetId) : -1;
                      return (
                        <div className={`studio-image-card${cover ? ' studio-image-card--cover' : ''}${isVideo ? ' studio-image-card--video' : ''}`} key={binding.assetId}>
                          {isVideo ? (
                            <video className="studio-image-thumb studio-image-thumb--video" src={`wmb-asset://${binding.assetId}`}
                              poster={binding.posterAssetId ? `wmb-asset://${binding.posterAssetId}` : undefined}
                              muted playsInline preload="metadata" aria-label={`视频预览 ${binding.ordinal + 1}`} />
                          ) : (
                            <img className="studio-image-thumb" src={`wmb-asset://${binding.assetId}`} alt="" loading="lazy" />
                          )}
                          <div className="studio-image-card-main">
                            <span className="studio-image-ordinal">{isVideo ? '视频' : '图'} {binding.ordinal + 1}{cover && <span className="studio-image-cover-badge">封面</span>}</span>
                            {isVideo && binding.clipRange && <span className="studio-image-crop-chip">已截取 {formatMs(binding.clipRange.startMs)}–{formatMs(binding.clipRange.endMs)}</span>}
                            {isVideo && binding.posterAssetId && <span className="studio-image-crop-chip">已设封面</span>}
                            {binding.cropRegion != null && <span className="studio-image-crop-chip">已裁切</span>}
                            {editing ? (
                              <input
                                className="studio-image-caption-input"
                                autoFocus
                                value={imageMenuAltDrafts[key] ?? effectiveCaption}
                                aria-label={`图 ${binding.ordinal + 1} 图注`}
                                onChange={(event) => setImageMenuAltDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') { event.preventDefault(); saveCaptionEdit(ref); }
                                  if (event.key === 'Escape') { event.stopPropagation(); setImageMenuEditKey(null); }
                                }}
                              />
                            ) : (
                              <span className={`studio-image-caption${effectiveCaption ? '' : ' empty'}`}>{effectiveCaption || '未填写图注'}</span>
                            )}
                            <span className="studio-image-meta">{fileName}{asset ? ` · ${formatAssetSize(asset.byteCount)}` : ''}</span>
                          </div>
                          <div className="studio-image-actions">
                            <button type="button" className="studio-image-move-up" aria-label={`上移图 ${binding.ordinal + 1}`} disabled={isFirst || busy} onClick={() => updateActivePlatformDraft({ mediaBindings: shiftPlatformBindingOrdinal(currentPlatformBindings, binding.assetId, -1) })}>↑</button>
                            <button type="button" className="studio-image-move-down" aria-label={`下移图 ${binding.ordinal + 1}`} disabled={isLast || busy} onClick={() => updateActivePlatformDraft({ mediaBindings: shiftPlatformBindingOrdinal(currentPlatformBindings, binding.assetId, 1) })}>↓</button>
                            {!isVideo && (
                              <button type="button" className="studio-image-cover-toggle" aria-label={cover ? '取消封面' : '设为封面'} disabled={busy} onClick={() => updateActivePlatformDraft({ mediaBindings: setPlatformCover(currentPlatformBindings, binding.assetId, !cover, activePlatform) })}>{cover ? '取消封面' : '设为封面'}</button>
                            )}
                            {!isVideo && <button type="button" onClick={() => locateAssetImage(ref)}>定位</button>}
                            {!readOnlyVersion && <>
                              {isVideo ? (
                                <>
                                  <button type="button" disabled={busy || posterCandidates.length === 0}
                                    title={posterCandidates.length === 0 ? '该视频暂无关键帧/封面' : '从关键帧/封面循环选择'}
                                    onClick={() => cycleVideoPoster({ assetId: binding.assetId, posterAssetId: binding.posterAssetId ?? null })}>封面{posterCandidates.length > 0 ? ` ${posterIndex + 1}/${posterCandidates.length}` : ''}</button>
                                  <button type="button" disabled={busy} onClick={() => startVideoClipEdit({ assetId: binding.assetId, clipRange: binding.clipRange ?? null, durationMs: binding.durationMs ?? null })}>{binding.clipRange ? '改截取' : '截取'}</button>
                                </>
                              ) : (
                                <>
                                  <button type="button" disabled={busy || busyCard} onClick={() => requestReplaceAssetImage(ref)}>{busyCard ? '替换中…' : '替换'}</button>
                                  <button type="button" className="studio-image-crop-button" disabled={busy || busyCard} onClick={() => openCropAssetImage(ref)}>裁剪</button>
                                </>
                              )}
                              {editing
                                ? <button type="button" className="primary" onClick={() => saveCaptionEdit(ref)}>保存图注</button>
                                : <button type="button" disabled={busy} onClick={() => startCaptionEdit(ref)}>编辑图注</button>}
                              <button type="button" className="danger" disabled={busy} onClick={() => removePlatformAsset(binding.assetId)}>移出</button>
                            </>}
                          </div>
                          {videoClipEdit?.assetId === binding.assetId && (
                            <div className="studio-image-clip-editor" aria-label={`截取时间段 ${binding.assetId}`}>
                              <input type="number" min={0} max={60} step={1} value={videoClipEdit.start} aria-label="截取起始秒"
                                onChange={(event) => setVideoClipEdit({ ...videoClipEdit, start: event.target.value })} />
                              <span aria-hidden="true">–</span>
                              <input type="number" min={0} max={60} step={1} value={videoClipEdit.end} aria-label="截取结束秒"
                                onChange={(event) => setVideoClipEdit({ ...videoClipEdit, end: event.target.value })} />
                              <button type="button" className="primary" disabled={busy} onClick={() => saveVideoClipEdit(binding.assetId)}>保存</button>
                              <button type="button" onClick={() => setVideoClipEdit(null)}>取消</button>
                            </div>
                          )}
                        </div>
                      );
                    }) : assetImageRefs.map((ref, index) => {
                      const asset = assetById.get(ref.assetId);
                      const key = `${ref.assetId}:${ref.occurrence}`;
                      const editing = imageMenuEditKey === key;
                      const busyCard = imageMenuBusyIndex === index;
                      const fileName = asset ? (asset.relativePath.split(/[/\\]/).pop() || asset.relativePath) : ref.assetId;
                      return (
                        <div className="studio-image-card" key={`${key}:${ref.start}`}>
                          <img className="studio-image-thumb" src={`wmb-asset://${ref.assetId}`} alt="" loading="lazy"/>
                          <div className="studio-image-card-main">
                            <span className="studio-image-ordinal">图 {index + 1}</span>
                            {editing ? (
                              <input
                                className="studio-image-caption-input"
                                autoFocus
                                value={imageMenuAltDrafts[key] ?? ref.alt}
                                aria-label={`图 ${index + 1} 图注`}
                                onChange={(event) => setImageMenuAltDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') { event.preventDefault(); saveCaptionEdit(ref); }
                                  if (event.key === 'Escape') { event.stopPropagation(); setImageMenuEditKey(null); }
                                }}
                              />
                            ) : (
                              <span className={`studio-image-caption${ref.alt ? '' : ' empty'}`}>{ref.alt || '未填写图注'}</span>
                            )}
                            <span className="studio-image-meta">{fileName}{asset ? ` · ${formatAssetSize(asset.byteCount)}` : ''}</span>
                          </div>
                          <div className="studio-image-actions">
                            <button type="button" onClick={() => locateAssetImage(ref)}>定位</button>
                            {!readOnlyVersion && <>
                              <button type="button" disabled={busy || busyCard} onClick={() => requestReplaceAssetImage(ref)}>{busyCard ? '替换中…' : '替换'}</button>
                              <button type="button" className="studio-image-crop-button" disabled={busy || busyCard} onClick={() => openCropAssetImage(ref)}>裁剪</button>
                              {editing
                                ? <button type="button" className="primary" onClick={() => saveCaptionEdit(ref)}>保存图注</button>
                                : <button type="button" disabled={busy} onClick={() => startCaptionEdit(ref)}>编辑图注</button>}
                              <button type="button" className="danger" disabled={busy} onClick={() => removeAssetImage(ref)}>移出</button>
                            </>}
                          </div>
                        </div>
                      );
                    })}
                    </div>
                    {mediaRecommendations != null && (
                      <>
                        <div className="studio-image-menu-divider" role="separator" aria-hidden="true" />
                        <StudioMediaSuggestions
                          readModel={mediaRecommendations}
                          sourceMedia={selected?.sourceMedia ?? []}
                          activePlatform={activePlatform}
                          readOnlyVersion={Boolean(readOnlyVersion)}
                          busy={busy}
                          generating={recommendationsGenerating}
                          onGenerate={() => { void generateRecommendations(); }}
                          onAccept={(recommendation) => { void acceptRecommendation(recommendation); }}
                          onReject={(recommendation) => { void rejectRecommendation(recommendation); }}
                          onSeekVideo={seekStudioVideo}
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            <StudioResearchGate gaps={researchGapForProject} message={researchGapMessage} error={researchGapsError} busyId={researchBusyId} onDecide={decideResearchGap} />
            <span className={message ? 'studio-status-message' : undefined}>
              {message || (readOnlyVersion ? '历史版本只读' : dirty ? '未保存' : anyDirty ? '其他页签有未保存修改' : '已保存')}
            </span>
          </div>
        </>}
        {tab === 'sources' && <section className="studio-detail-list">{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><span>资料来源</span><h3>{source.title}</h3><p>{source.summary || '暂无摘要'}</p><small className="studio-source-meta"><SourcePlatformMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation}/><span>{[source.author, source.publishedAt && formatTime(source.publishedAt)].filter(Boolean).join(' · ')}</span></small>{source.canonicalUrl && <button className="secondary-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}</article>) : <div className="compact-empty"><h2>没有关联资料</h2><p>该项目尚未绑定资料来源。</p></div>}</section>}
        {tab === 'investigation' && <StudioInvestigationPanel projectId={selected.id} sources={selected.sources} onOpenSource={onOpenSource} onOpenWriting={() => setTab('core')} onIndicatorChange={setInvestigationIndicator} />}
        {tab === 'assets' && <section className="studio-detail-list">{selected.assets.length ? selected.assets.map((asset) => <article key={asset.id}><span>{asset.mimeType}</span><h3>{asset.relativePath}</h3><p>素材指纹 {asset.sha256}</p><small>{asset.byteCount} 字节{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}{asset.durationMs ? ` · ${asset.durationMs} 毫秒` : ''} · {asset.origin}</small></article>) : <div className="compact-empty"><h2>没有关联素材</h2><p>只有被平台版本真实引用的素材才会显示。</p></div>}</section>}
      </> : <section className="empty-state editor-empty"><h2>{message ? '项目详情读取失败' : '选择一个内容项目'}</h2><p>{message || '左侧会显示符合当前条件的项目。'}</p>{selectedId && message && <button onClick={() => void loadDetail(selectedId)}>重新读取</button>}</section>}
    </main>
    </div>
    <StudioHistoryModal open={historyOpen} selected={selected} setTab={setTab} setViewedVersionId={setViewedVersionId} latestId={latest?.id} activePlatform={activePlatform} selectedPlatformVersionId={activePlatform ? platformSelections[activePlatform] ?? activePlatformVersion?.id : null} setSelectedPlatformVersionId={(value) => { if (activePlatform) setPlatformSelections((current) => ({ ...current, [activePlatform]: value })); }} annotationView={{
      tab: contextPanelTab,
      setTab: setContextPanelTab,
      openCount: openAnnotationRows.length,
      versionCount: annotationVersionCount,
      rows: annotationRows,
      loading: annotationsLoading,
      error: annotationsError,
      onRetry: reloadAnnotations,
      selectedId: selectedAnnotationId,
      onSelectCard: selectAnnotationFromBody,
      onLocate: locateAnnotation,
      onEditNote: (annotationId, x, y) => setNoteInput({ x, y, mode: 'edit', annotationId, initial: annotationRows.find((row) => row.id === annotationId)?.note ?? '' }),
      onRemove: (annotationId) => { void removeAnnotation(annotationId); },
      onReopen: (annotationId) => { void reopenAnnotation(annotationId); },
      onDiscussPi: discussAnnotationsWithPi,
      busy: annotationBusy
    }} onRequestClose={() => setHistoryOpen(false)}/>
    {annotationMenu && <StudioAnnotationMenu x={annotationMenu.x} y={annotationMenu.y} items={annotationMenuItems} onClose={() => setAnnotationMenu(null)} />}
    {noteInput && <StudioAnnotationNoteInput
      x={noteInput.x}
      y={noteInput.y}
      title={noteInput.mode === 'create' ? '标记并说明' : '编辑说明'}
      initial={noteInput.mode === 'edit' ? noteInput.initial : ''}
      submitLabel={noteInput.mode === 'create' ? '创建标记' : '保存说明'}
      busy={annotationBusy}
      onConfirm={(note) => { void confirmNoteInput(note); }}
      onCancel={() => setNoteInput(null)}
    />}
    {cropTarget ? (
      <StudioImageCropDialog
        assetId={cropTarget.assetId}
        assetName={cropTarget.assetName}
        derive={activePlatform ? undefined : deriveCropAsset}
        onApply={applyCropResult}
        onClose={() => setCropTarget(null)}
      />
    ) : null}
    {inlineSelection && (
      <StudioInlineImageOverlay
        selection={inlineSelection}
        findFigure={findInlineFigure}
        draft={inlineDraft}
        alt={inlineAlt}
        editable={Boolean(selected && !readOnlyVersion && !busy)}
        showLayout={!activePlatform}
        canMoveUp={canMoveInlineUp}
        canMoveDown={canMoveInlineDown}
        onMoveUp={() => moveInlineFigure(-1)}
        onMoveDown={() => moveInlineFigure(1)}
        onWidthPreset={handleInlineWidth}
        onAlign={handleInlineAlign}
        onReplace={handleInlineReplace}
        onEditCaption={handleInlineCaption}
        onCrop={handleInlineCrop}
        onRemove={handleInlineRemove}
        onClose={() => setInlineSelection(null)}
      />
    )}
  </section>;
}
