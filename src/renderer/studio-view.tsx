import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentProjectDetail, ContentProjectOrder, ContentProjectPlatform, ContentProjectStatus, ContentProjectStatusSummary, ContentProjectSummary } from '../main/content';
import type { StudioAnnotation, StudioDocumentScope, StudioPlatform } from '../shared/studio-annotations';
import { assetImageToken, bodyWithoutLeadingTitle, contentMediaLayoutMap, formatAssetSize, formatTime, htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, parseAssetImages, platformNames, removeAssetImageToken, renderMarkdown, replaceAssetImageToken, statuses, updateAssetImageAlt, updateContentMediaBinding, wrapTextareaSelection, type StudioAssetImageRef } from './studio-view-helpers';
import { StudioEditorTop, StudioFormatBar, StudioHistoryModal, StudioLibraryHeader, StudioOutline } from './studio-view-panels';
import { StudioInlineImageOverlay, type InlineImageDraft, type InlineImageSelection } from './studio-image-toolbar';
import { StudioImageCropDialog, type StudioCropApplyResult, type StudioDeriveCropInput, type StudioDeriveCropResult } from './studio-image-crop';
import { buildAssetIdsFromPlatformBindings, contentBindingKey, type ContentMediaBinding, type ContentMediaBindingDraft, type MediaAlign, type MediaWidthPreset, type PlatformCropPayload, type PlatformMediaBindingDraft } from '../shared/media-bindings';
import { createStudioPlatformDraft, isStudioPlatformDraftDirty, addVideoPlatformBinding, platformBindingsToDrafts, platformMediaBindingsEqual, readPlatformVersionBindings, selectStudioPlatformVersion, setPlatformBindingCaption, setPlatformBindingClipRange, setPlatformBindingPoster, setPlatformCover, shiftPlatformBindingOrdinal, studioPlatformDraftKey, studioPlatformFromTab, syncPlatformBindingsToRefs, type StudioPlatformDraft, type StudioTab } from './studio-platform-tabs';
import { StudioMediaSuggestions, formatMs } from './studio-media-suggestions';
import type { MediaRecommendation, MediaRecommendationsReadModel } from '../shared/media-recommendations';
import { annotationContextAround, annotationScopeKey, computeBodyFingerprint, leadingTitleLength, trimToNonWhitespace, validateAnnotationSelection, shiftAnnotationRanges, type StudioAnnotationRow } from './studio-annotations';
import { StudioAnnotationMenu, StudioAnnotationNoteInput, StudioAnnotationOverlay, bodyOffsetAtDomPoint, richMapping, type SourceHitTest } from './studio-annotation-layer';
import { appConfirm } from './app-confirm';
import { priorityGrade } from './today-view-parts';
import { SourcePlatformMark } from './source-mark';

type StudioSelectionSnapshot = { start: number; end: number; basis: string };
type StudioFocusObject = {
  type: string; id: string; title: string; summary?: string | null;
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty'; bodyExcerpt?: string | null; bodyChars?: number;
  studioDocument?: { projectId: string; documentKind: 'core' | 'platform'; documentId: string | null; platform: StudioPlatform | null; title: string; currentBody: string; bodyFingerprint: string; dirty: boolean };
  openAnnotations?: Array<Pick<StudioAnnotation, 'id' | 'startOffset' | 'endOffset' | 'quotedText' | 'prefixContext' | 'suffixContext' | 'note'>>;
};

// ---- WMB-5237 核心媒体布局草稿：detail 读模型 → 草稿（字段名以 src/shared/media-bindings.ts 为准） ----
function coreBindingsFromDetail(detail: ContentProjectDetail | null): ContentMediaBindingDraft[] {
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

function coreMediaBindingsEqual(a: ContentMediaBindingDraft[], b: ContentMediaBindingDraft[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.assetId !== y.assetId || x.occurrence !== y.occurrence || x.widthPreset !== y.widthPreset || x.align !== y.align
      || (x.caption ?? null) !== (y.caption ?? null) || (x.linkUrl ?? null) !== (y.linkUrl ?? null)) return false;
  }
  return true;
}

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
  const [copyTitle, setCopyTitle] = useState(''); const [findOpen, setFindOpen] = useState(false); const [findText, setFindText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false); const [editorMode, setEditorMode] = useState<'rich' | 'source'>('source');
  const [creating, setCreating] = useState(false); const [newTitle, setNewTitle] = useState('');
  const bodyInput = useRef<HTMLDivElement>(null); const sourceInput = useRef<HTMLTextAreaElement>(null);
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
  useEffect(()=>{void window.wmb.listKnowledgeTopics({limit:100}).then((page)=>setTopics(page?.items ?? []));},[]);
  useEffect(() => { setOffset(0); }, [query, status, archived, order, platform]);
  useEffect(() => { if (!selectedId) { setSelected(null); setPlatformSelections({}); setPlatformDrafts({}); onContext(null); } }, [selectedId]);
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
    }
  }, [activeLayoutMap]);
  // 布局草稿 / 正文变化后重新投影（富文本编辑器、源码实时预览、只读历史共用）。
  useEffect(() => {
    if (!editorTab) return;
    const roots = [bodyInput.current, ...Array.from(document.querySelectorAll<HTMLElement>('.studio-live-false-body'))].filter(Boolean) as HTMLElement[];
    for (const root of roots) applyInlineLayout(root);
  }, [editorTab, displayBody, editorMode, readOnlyVersion?.id, applyInlineLayout]);
  useEffect(() => {
    if (!editorTab) return;
    if (editorMode !== 'rich' && !readOnlyVersion) return;
    const editor = bodyInput.current;
    if (!editor) return;
    if (document.activeElement === editor && editorMode === 'rich' && !readOnlyVersion) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
    applyInlineLayout(editor);
  }, [tab, editorTab, displayBody, readOnlyVersion?.id, editorMode]);
  useEffect(() => {
    if (!editorTab) return;
    if (!(readOnlyVersion || editorMode === 'rich')) return;
    const editor = bodyInput.current;
    if (!editor) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
    applyInlineLayout(editor);
  }, [tab, editorTab, editorMode, readOnlyVersion?.id, displayBody]);
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
    const history = bodyHistory.current.slice(0, bodyHistoryIndex.current + 1);
    if (history[history.length - 1] !== next) history.push(next);
    bodyHistory.current = history;
    bodyHistoryIndex.current = history.length - 1;
    applyEditorBody(next);
  };
  const moveHistory = (direction: -1 | 1) => {
    const next = bodyHistoryIndex.current + direction;
    if (next < 0 || next >= bodyHistory.current.length) return;
    bodyHistoryIndex.current = next;
    applyEditorBody(bodyHistory.current[next]);
  };
  const insertMarkdown = (snippet: string) => {
    if (readOnlyVersion) return;
    if (editorMode === 'source') {
      const textarea = sourceInput.current;
      if (!textarea) {
        changeBody(`${editorBody}${editorBody.endsWith('\n') || !editorBody ? '' : '\n\n'}${snippet}`);
        return;
      }
      textarea.focus();
      changeBody(insertTextAtCursor(textarea, snippet));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) {
      changeBody(`${editorBody}${editorBody.endsWith('\n') || !editorBody ? '' : '\n\n'}${snippet}`);
      return;
    }
    editor.focus();
    document.execCommand('insertHTML', false, renderMarkdown(snippet));
    changeBody(htmlToMarkdown(editor));
  };
  const formatSelection = (before: string, after = before, placeholder = '文字') => {
    if (readOnlyVersion) return;
    if (editorMode === 'source') {
      const textarea = sourceInput.current;
      if (!textarea) return;
      textarea.focus();
      changeBody(wrapTextareaSelection(textarea, before, after, placeholder));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) return;
    editor.focus();
    const command = before === '**' ? 'bold' : before === '*' ? 'italic' : before === '~~' ? 'strikeThrough' : before === '- ' ? 'insertUnorderedList' : before === '> ' ? 'formatBlock' : '';
    if (command === 'formatBlock') document.execCommand(command, false, 'blockquote');
    else if (command) document.execCommand(command);
    else if (before === '## ') document.execCommand('formatBlock', false, 'h2');
    else if (before === '### ') document.execCommand('formatBlock', false, 'h3');
    else if (before === '[') {
      const url = window.prompt('粘贴链接地址');
      if (url) document.execCommand('createLink', false, url);
    } else if (before.startsWith('```')) {
      insertMarkdown(`\n\`\`\`\n${placeholder}\n\`\`\`\n`);
      return;
    } else document.execCommand('insertText', false, `${before}${placeholder}${after}`);
    changeBody(htmlToMarkdown(editor));
  };
  const execRich = (command: string, value?: string) => {
    if (editorMode === 'source') {
      if (command === 'bold') return formatSelection('**');
      if (command === 'italic') return formatSelection('*');
      if (command === 'strikeThrough') return formatSelection('~~');
      if (command === 'insertUnorderedList') return insertMarkdown('\n- 列表项\n');
      if (command === 'insertOrderedList') return insertMarkdown('\n1. 列表项\n');
      if (command === 'formatBlock' && value === 'h2') return insertMarkdown('\n## 二级标题\n\n');
      if (command === 'formatBlock' && value === 'h3') return insertMarkdown('\n### 三级标题\n\n');
      if (command === 'formatBlock' && value === 'blockquote') return insertMarkdown('\n> 引用\n\n');
      if (command === 'formatBlock' && value === 'p') return insertMarkdown('\n');
      if (command === 'undo') return moveHistory(-1);
      if (command === 'redo') return moveHistory(1);
      return;
    }
    const editor = bodyInput.current;
    if (!editor || readOnlyVersion) return;
    editor.focus();
    document.execCommand(command, false, value);
    changeBody(htmlToMarkdown(editor));
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
    setBusy(true);
    setMessage(file ? '正在插入图片…' : '选择图片…');
    try {
      let result: Awaited<ReturnType<typeof window.wmb.importStudioImage>>;
      if (file) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (const byte of buffer) binary += String.fromCharCode(byte);
        result = await window.wmb.importStudioImage({
          projectId: selected.id,
          fileName: file.name,
          mimeType: file.type,
          bytesBase64: btoa(binary),
          alt: file.name.replace(/\.[^.]+$/, '')
        });
      } else {
        result = await window.wmb.importStudioImage({ projectId: selected.id });
      }
      if (!result.ok) {
        setMessage(result.cancelled ? '' : '插入图片失败');
        return;
      }
      if (activePlatform) updateActivePlatformDraft({ assetIds: [...new Set([...(activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? []), result.asset.id])] });
      insertMarkdown(`${result.markdown}\n\n`);
      setMessage(result.reused ? '已插入已有图片素材' : '图片已插入');
      const detail = await window.wmb.getStudioProject(selected.id); if (detail) setSelected(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (imageInput.current) imageInput.current.value = '';
    }
  };
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
  // ---- WMB-5246 素材建议：生成/接受/拒绝（media-recommendations:* IPC；接受=独立保存边界）----
  const loadRecommendations = useCallback(async () => {
    if (!selected) return;
    const latest = selected.revisions[0];
    if (!latest) { setMediaRecommendations(null); return; }
    setRecommendationsLoading(true);
    try {
      const model = await window.wmb.listMediaRecommendations({ contentVersionId: latest.id, projectId: selected.id });
      setMediaRecommendations(model);
    } catch {
      setMediaRecommendations(null);
    } finally {
      setRecommendationsLoading(false);
    }
  }, [selected?.id, selected?.revisions[0]?.id]);
  useEffect(() => {
    void loadRecommendations();
  }, [loadRecommendations]);
  const posterCandidatesForAsset = (assetId: string): Array<{ assetId: string; timeMs: number | null }> => {
    const media = (selected?.sourceMedia ?? []).find((item) => item.assetId === assetId);
    const keyframes = media?.video?.keyframes.map((frame) => ({ assetId: frame.assetId, timeMs: frame.timeMs })) ?? [];
    const posters = (selected?.sourceMedia ?? [])
      .filter((item) => item.kind === 'video_poster' && item.sourceId === media?.sourceId)
      .map((item) => ({ assetId: item.assetId, timeMs: null }));
    return [...posters, ...keyframes];
  };
  const generateRecommendations = async () => {
    if (!selected || busy) return;
    const latest = selected.revisions[0];
    if (!latest) { setMessage('请先保存核心正文，再生成媒体建议'); return; }
    const sourceRevisionKeys = [...new Set((selected.sourceMedia ?? []).map((item) => item.sourceRevisionKey))];
    if (sourceRevisionKeys.length === 0) { setMessage('项目资料暂无已保存的来源媒体（归档完成后可生成建议）'); return; }
    setRecommendationsGenerating(true);
    try {
      const result = await window.wmb.generateMediaRecommendations({
        contentVersionId: latest.id,
        projectId: selected.id,
        sourceRevisionKeys
      });
      if (!result?.ok) {
        setMessage(result?.error?.message ?? '生成媒体建议失败');
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
    if (recommendation.mediaKind === 'video' && !activePlatform) {
      setMessage('视频是结构化附件，请先打开平台页签再接受');
      return;
    }
    const result = await window.wmb.decideMediaRecommendation({ id: recommendation.id, expectedRevision: recommendation.revision, decision: 'accept' });
    if (!result?.ok) {
      setMessage(result?.error?.message ?? '接受建议失败');
      await loadRecommendations();
      return;
    }
    // 放入草稿：图片 → 正文 token（同步产生平台绑定）；视频 → 平台结构化附件绑定（绝不进入 token）。
    if (recommendation.mediaKind === 'video') {
      const media = (selected?.sourceMedia ?? []).find((item) => item.assetId === recommendation.assetId);
      const clipRange = recommendation.transform.kind === 'clip'
        ? { startMs: recommendation.transform.startMs, endMs: recommendation.transform.endMs }
        : null;
      const defaultPoster = (selected?.sourceMedia ?? [])
        .find((item) => item.kind === 'video_poster' && item.sourceId === media?.sourceId)?.assetId ?? null;
      updateActivePlatformDraft({
        mediaBindings: addVideoPlatformBinding(currentPlatformBindings, {
          assetId: recommendation.assetId,
          posterAssetId: defaultPoster,
          clipRange,
          durationMs: clipRange ? clipRange.endMs - clipRange.startMs : media?.asset.durationMs ?? null,
          caption: recommendation.caption || null
        })
      });
      setMessage(clipRange ? `已接受视频片段 ${formatMs(clipRange.startMs)}–${formatMs(clipRange.endMs)}（保存平台版本时物化）` : '已接受视频附件（保存平台版本时生效）');
    } else {
      const caption = recommendation.caption?.trim() || '来源素材';
      insertMarkdown(`${assetImageToken(caption, recommendation.assetId)}\n\n`);
      setMessage('已接受并放入正文（保存版本时写入绑定）');
    }
    await loadRecommendations();
  };
  const rejectRecommendation = async (recommendation: MediaRecommendation) => {
    if (readOnlyVersion || busy) return;
    const result = await window.wmb.decideMediaRecommendation({ id: recommendation.id, expectedRevision: recommendation.revision, decision: 'reject' });
    setMessage(result?.ok ? '已拒绝该建议（不写入任何版本）' : (result?.error?.message ?? '拒绝失败'));
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
    const draft = videoClipEdit;
    if (!draft || draft.assetId !== assetId) return;
    const start = Number(draft.start);
    const end = Number(draft.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 60) {
      setMessage('截取时间段无效：需 0 ≤ start < end 且不超过 60 秒');
      return;
    }
    updateActivePlatformDraft({ mediaBindings: setPlatformBindingClipRange(currentPlatformBindings, assetId, { startMs: start * 1000, endMs: end * 1000 }) });
    setVideoClipEdit(null);
    setMessage(`已设置截取 ${formatMs(start * 1000)}–${formatMs(end * 1000)}（保存平台版本时物化）`);
  };
  const cycleVideoPoster = (binding: { assetId: string; posterAssetId: string | null }) => {
    const candidates = posterCandidatesForAsset(binding.assetId);
    if (candidates.length === 0) { setMessage('该视频暂无关键帧/封面可设'); return; }
    const currentIndex = candidates.findIndex((candidate) => candidate.assetId === binding.posterAssetId);
    const next = candidates[(currentIndex + 1) % candidates.length];
    updateActivePlatformDraft({ mediaBindings: setPlatformBindingPoster(currentPlatformBindings, binding.assetId, next.assetId) });
    setMessage('已切换视频封面（保存平台版本时生效）');
  };
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
  const locateAssetImage = (ref: StudioAssetImageRef) => {
    setImageMenuEditKey(null);
    if (editorMode === 'source' && !readOnlyVersion) {
      const textarea = sourceInput.current;
      if (!textarea) return;
      textarea.focus();
      const lines = editorBody.split('\n');
      const lineIndex = Math.min(lines.length - 1, editorBody.slice(0, ref.start).split('\n').length - 1);
      const ratio = lines.length > 1 ? lineIndex / (lines.length - 1) : 0;
      textarea.scrollTop = Math.max(0, (textarea.scrollHeight - textarea.clientHeight) * ratio);
      try { textarea.setSelectionRange(ref.start, ref.end); } catch { /* 选区越界时忽略 */ }
      canvasRef.current?.scrollTo({ top: Math.max(0, textarea.offsetTop - 24), behavior: 'smooth' });
      return;
    }
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const roots = [bodyInput.current, document.querySelector<HTMLElement>('.studio-live-false-body')].filter(Boolean) as HTMLElement[];
      for (const root of roots) {
        const figures = [...root.querySelectorAll('figure[data-wmb-asset]')];
        const figure = figures.filter((node) => node.getAttribute('data-wmb-asset') === ref.assetId)[ref.occurrence];
        if (figure) {
          figure.scrollIntoView({ block: 'center', behavior });
          figure.classList.add('studio-figure-flash');
          window.setTimeout(() => figure.classList.remove('studio-figure-flash'), 1400);
          return;
        }
      }
    }));
  };
  const requestReplaceAssetImage = (ref: StudioAssetImageRef) => {
    if (readOnlyVersion || busy) return;
    pendingReplaceRef.current = { assetId: ref.assetId, occurrence: ref.occurrence };
    replaceImageInput.current?.click();
  };
  const replaceAssetImage = async (file?: File) => {
    const pending = pendingReplaceRef.current;
    pendingReplaceRef.current = null;
    if (!selected || !pending || !file || readOnlyVersion) return;
    const pendingIndex = assetImageRefs.findIndex((item) => item.assetId === pending.assetId && item.occurrence === pending.occurrence);
    setImageMenuBusyIndex(pendingIndex);
    setMessage('正在替换图片…');
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of buffer) binary += String.fromCharCode(byte);
      const result = await window.wmb.importStudioImage({
        projectId: selected.id,
        fileName: file.name,
        mimeType: file.type,
        bytesBase64: btoa(binary),
        alt: file.name.replace(/\.[^.]+$/, '')
      });
      if (!result.ok) {
        setMessage(result.cancelled ? '' : '替换图片失败');
        return;
      }
      const next = replaceAssetImageToken(editorBody, pending.assetId, pending.occurrence, result.markdown);
      if (next === editorBody) { setMessage('找不到要替换的图片'); return; }
      changeBody(next);
      syncPlatformBindingsForBody(next);
      setMessage('图片已替换');
      const detail = await window.wmb.getStudioProject(selected.id); if (detail) setSelected(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImageMenuBusyIndex(null);
      if (replaceImageInput.current) replaceImageInput.current.value = '';
    }
  };
  const removeAssetImage = (ref: StudioAssetImageRef) => {
    if (readOnlyVersion || busy) return;
    const next = removeAssetImageToken(editorBody, ref.assetId, ref.occurrence);
    if (next === editorBody) return;
    changeBody(next);
    syncPlatformBindingsForBody(next);
    setMessage('已移出本文');
  };
  const startCaptionEdit = (ref: StudioAssetImageRef) => {
    const key = `${ref.assetId}:${ref.occurrence}`;
    setImageMenuEditKey(key);
    setImageMenuAltDrafts((current) => ({ ...current, [key]: ref.alt }));
  };
  const saveCaptionEdit = (ref: StudioAssetImageRef) => {
    const key = `${ref.assetId}:${ref.occurrence}`;
    const alt = (imageMenuAltDrafts[key] ?? ref.alt).trim();
    setImageMenuEditKey(null);
    setImageMenuAltDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    if (activePlatform) {
      // 平台页签：编辑的是平台图注覆盖（绑定字段，draft-only，不改正文 token/批注偏移）
      const binding = currentPlatformBindings.find((item) => item.assetId === ref.assetId);
      const nextCaption = alt || null;
      if (binding && (binding.caption ?? null) === nextCaption) return;
      updateActivePlatformDraft({ mediaBindings: setPlatformBindingCaption(currentPlatformBindings, ref.assetId, nextCaption) });
      setMessage(nextCaption ? '平台图注已更新' : '已清除平台图注（沿用核心图注）');
      return;
    }
    if (alt === ref.alt) return;
    const next = updateAssetImageAlt(editorBody, ref.assetId, ref.occurrence, alt);
    if (next !== editorBody) { changeBody(next); setMessage('图注已更新'); }
  };
  // 平台页签：按 asset 移出全部 occurrence（绑定随对账移除；裁切像素一并清理）。
  const removePlatformAsset = (assetId: string) => {
    if (readOnlyVersion || busy) return;
    let next = editorBody;
    while (parseAssetImages(next).some((ref) => ref.assetId === assetId)) {
      const changed = removeAssetImageToken(next, assetId, 0);
      if (changed === next) break;
      next = changed;
    }
    if (next === editorBody) return;
    changeBody(next);
    setPlatformCropPayloads((current) => { const nextPayloads = { ...current }; delete nextPayloads[assetId]; return nextPayloads; });
    setMessage('已移出本文');
  };
  // ---- WMB-5237 裁切：核心替换 occurrence / 平台写 derived binding（正文 token 不变） ----
  const openCropAssetImage = (ref: StudioAssetImageRef) => {
    if (readOnlyVersion || busy) return;
    setImageMenuOpen(false);
    const asset = assetById.get(ref.assetId);
    setCropTarget({
      assetId: ref.assetId,
      occurrence: ref.occurrence,
      alt: ref.alt,
      assetName: asset ? (asset.relativePath.split(/[/\\]/).pop() || asset.relativePath) : null
    });
  };
  const deriveCropAsset = async (input: StudioDeriveCropInput): Promise<StudioDeriveCropResult> => {
    try {
      const result = await window.wmb.deriveStudioAsset({
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
    const target = cropTarget;
    if (!target || !selected) throw new Error('项目已变化，请重新打开裁切。');
    if (activePlatform) {
      // 平台页签：像素进保存 payload，绑定写 cropRegion（derivedAssetId 由保存事务物化后回填）
      const currentBindings: PlatformMediaBindingDraft[] = currentPlatformBindings;
      const targetIndex = currentBindings.findIndex((binding) => binding.assetId === target.assetId);
      const nextBindings =
        targetIndex >= 0
          ? currentBindings.map((binding) => (binding.assetId === target.assetId ? { ...binding, cropRegion: result.cropRegion } : binding))
          : [...currentBindings, { assetId: target.assetId, ordinal: currentBindings.length, isCover: currentBindings.length === 0, cropRegion: result.cropRegion }];
      setPlatformCropPayloads((current) => ({
        ...current,
        [target.assetId]: { assetId: target.assetId, cropRegion: result.cropRegion, pngBase64: result.pngBase64 }
      }));
      updateActivePlatformDraft({ mediaBindings: nextBindings });
      setMessage('已应用裁剪（保存平台版本时生效）');
    } else {
      // 核心页签：派生 asset 精确替换当前 occurrence，图注与 provenance 保留
      if (!result.derivedAssetId) throw new Error('图片处理服务未返回派生图');
      const next = replaceAssetImageToken(editorBody, target.assetId, target.occurrence, assetImageToken(target.alt, result.derivedAssetId));
      if (next === editorBody) throw new Error('找不到要裁剪的图片');
      changeBody(next);
      syncPlatformBindingsForBody(next);
      setMessage('已裁剪并替换当前图片');
      const detail = await window.wmb.getStudioProject(selected.id); if (detail) setSelected(detail);
    }
  };
  // ---- WMB-5237 正文内图片：点击选中 + 浮动工具条接线（布局只写 coreMediaDraft，绝不写正文）----
  const findInlineFigure = useCallback((sel: InlineImageSelection): HTMLElement | null => {
    const roots = [bodyInput.current, ...Array.from(document.querySelectorAll<HTMLElement>('.studio-live-false-body'))].filter(Boolean) as HTMLElement[];
    for (const root of roots) {
      const all = [...root.querySelectorAll<HTMLElement>('figure.studio-figure')].filter((node) => node.getAttribute('data-wmb-asset') === sel.assetId);
      // 优先 data-wmb-occurrence 精确匹配；旧 DOM（无属性）回退同 assetId 出现序。
      const figure = all.find((node) => node.getAttribute('data-wmb-occurrence') === String(sel.occurrence)) ?? all[sel.occurrence];
      if (figure) return figure;
    }
    return null;
  }, []);
  const inlineFigureOccurrence = (root: Element, figure: Element, assetId: string): number => {
    const figures = [...root.querySelectorAll<HTMLElement>('figure.studio-figure')].filter((node) => node.getAttribute('data-wmb-asset') === assetId);
    return Math.max(0, figures.indexOf(figure as HTMLElement));
  };
  const handleInlineFigureClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!selected) return;
    const target = event.target as HTMLElement;
    const figure = target.closest?.('figure.studio-figure');
    if (!figure || !(figure instanceof HTMLElement)) return;
    const assetId = figure.getAttribute('data-wmb-asset');
    if (!assetId) return;
    event.preventDefault();
    const attrOccurrence = figure.getAttribute('data-wmb-occurrence');
    const root = figure.closest('.studio-rich-editor') ?? figure.closest('.studio-live-false-body');
    const occurrence = attrOccurrence !== null ? Number(attrOccurrence) : (root ? inlineFigureOccurrence(root, figure, assetId) : 0);
    setInlineSelection({ assetId, occurrence });
  };
  const inlineDraft = useMemo<InlineImageDraft | null>(() => {
    if (!inlineSelection || activePlatform) return null;
    const key = contentBindingKey(inlineSelection.assetId, inlineSelection.occurrence);
    const binding = coreMediaDraft.find((item) => contentBindingKey(item.assetId, item.occurrence) === key);
    return binding ? { widthPreset: binding.widthPreset, align: binding.align } : null;
  }, [inlineSelection, activePlatform, coreMediaDraft]);
  const inlineAlt = useMemo(() => {
    if (!inlineSelection) return '';
    return assetImageRefs.find((item) => item.assetId === inlineSelection.assetId && item.occurrence === inlineSelection.occurrence)?.alt ?? '';
  }, [inlineSelection, assetImageRefs]);
  const inlineRefOf = (): StudioAssetImageRef | null => {
    if (!inlineSelection) return null;
    return assetImageRefs.find((item) => item.assetId === inlineSelection.assetId && item.occurrence === inlineSelection.occurrence) ?? null;
  };
  const applyCoreMediaBinding = (assetId: string, occurrence: number, patch: Partial<Pick<ContentMediaBindingDraft, 'widthPreset' | 'align' | 'caption' | 'linkUrl'>>) => {
    setCoreMediaDraft((draft) => updateContentMediaBinding(draft, assetId, occurrence, patch));
  };
  const handleInlineWidth = (preset: MediaWidthPreset) => {
    if (!inlineSelection || readOnlyVersion || busy || activePlatform) return;
    applyCoreMediaBinding(inlineSelection.assetId, inlineSelection.occurrence, { widthPreset: preset });
  };
  const handleInlineAlign = (align: MediaAlign) => {
    if (!inlineSelection || readOnlyVersion || busy || activePlatform) return;
    applyCoreMediaBinding(inlineSelection.assetId, inlineSelection.occurrence, { align });
  };
  const handleInlineReplace = () => {
    const ref = inlineRefOf();
    if (ref) requestReplaceAssetImage(ref);
  };
  const handleInlineCaption = (alt: string) => {
    const ref = inlineRefOf();
    if (!ref) return;
    const next = updateAssetImageAlt(editorBody, ref.assetId, ref.occurrence, alt);
    if (next !== editorBody) { changeBody(next); setMessage('图注已更新'); }
  };
  const handleInlineRemove = () => {
    const ref = inlineRefOf();
    if (!ref) return;
    removeAssetImage(ref);
    setInlineSelection(null);
  };
  const handleInlineCrop = () => {
    if (!inlineSelection) return;
    setInlineSelection(null);
    // 裁切入口契约：crop worker 在 studio-view 监听 studio-inline-crop-request 打开裁切对话框
    window.dispatchEvent(new CustomEvent('studio-inline-crop-request', { detail: { assetId: inlineSelection.assetId, occurrence: inlineSelection.occurrence } }));
  };
  // Delete 键：选中图可删，但图注/搜索/标题等输入框聚焦或裁切对话框打开时绝不误删。
  useEffect(() => {
    if (!inlineSelection || readOnlyVersion || busy || cropTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete') return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      handleInlineRemove();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineSelection, readOnlyVersion, busy, cropTarget, editorBody, displayBody]);
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
  const save = async () => {
    if (!selected || busy || readOnlyVersion) return;
    if (!editorBody.trim() || (!activePlatform && !editorTitle.trim())) { setMessage(!editorBody.trim() ? '正文不能为空' : '标题不能为空'); return; }
    if (!dirty) {
      setMessage('内容没有改动');
      window.setTimeout(() => setMessage((current) => current === '内容没有改动' ? '' : current), 1600);
      return;
    }
    setBusy(true); setMessage('正在保存…');
    // 平台首版（平台版本行尚不存在）时跳过批注同步：批注只能挂在已存在的平台版本上
    // （validateScope 要求 platform 文档必须是真实 platform_versions 行），此时同步必然失败。
    const platformNewVersion = Boolean(activePlatform && !activePlatformVersion);
    if (annotationScope && rowsScopeKeyRef.current === annotationScopeKeyValue && !platformNewVersion) {
      const annotationsSynced = await syncAnnotationsToBody(annotationScope, annotationScopeKeyValue, editorBody, 'incremental');
      if (!annotationsSynced) {
        setMessage('批注同步失败，正文尚未保存，请重试');
        setBusy(false);
        return;
      }
    }
    window.clearTimeout(reconcileTimer.current);
    try {
      if (activePlatform) {
        if (!latest) { setMessage('请先保存核心正文，再创建平台版本'); return; }
        const draftBindings = activePlatformDraft?.mediaBindings;
        const savedBindings = draftBindings ?? platformSyncedBindings;
        const result = await window.wmb.saveStudioPlatform({
          projectId: selected.id,
          contentVersionId: activePlatformVersion?.contentVersionId ?? latest.id,
          platform: activePlatform,
          format: activePlatformVersion?.format ?? 'text',
          title: editorTitle.trim() || undefined,
          body: editorBody,
          assetIds: activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? [],
          mediaBindings: savedBindings,
          cropPayloads: Object.values(platformCropPayloads).filter((payload) => savedBindings.some((binding) => binding.assetId === payload.assetId)),
          // WMB-5246：视频绑定带 clipRange 时随保存事务物化 ≤60s 派生 Clip（IPC 层 stage、事务内注册）。
          clipPayloads: savedBindings
            .filter((binding) => binding.mediaKind === 'video' && binding.clipRange && (binding.derivedAssetId ?? null) === null)
            .map((binding) => ({ sourceAssetId: binding.assetId, startMs: binding.clipRange!.startMs, endMs: binding.clipRange!.endMs })),
          expectedRevision: activePlatformVersion?.revision,
          versionId: activePlatformVersion?.id
        });
        if (!result.ok || !result.data) {
          setMessage(result.error?.code === 'REVISION_CONFLICT' ? '平台版本已在其他位置更新，请重新打开项目后再保存' : result.error?.message || '保存失败');
          return;
        }
        const savedId = result.data.id;
        setPlatformSelections((current) => ({ ...current, [activePlatform]: savedId }));
        if (activePlatformDraftKey) setPlatformDrafts((current) => { const next = { ...current }; delete next[activePlatformDraftKey]; return next; });
        setPlatformCropPayloads({});
        const detail = await window.wmb.getStudioProject(selected.id); if (detail) setSelected(detail);
        await loadFirst(true);
        setAnnotationReloadTick((tick) => tick + 1);
        setMessage(`已保存${platformNames[activePlatform]}平台版本 · 版本 ${result.data.revision}`);
        return;
      }
      // WMB-5237 核心媒体草稿：图注与正文 alt 保持单源（保存载荷内同步，不动 state）。
      const coreSaveBindings = coreMediaDraft.length > 0
        ? coreMediaDraft.flatMap((binding) => {
                    const ref = parseAssetImages(editorBody).find((item) => item.assetId === binding.assetId && item.occurrence === binding.occurrence);
                    if (!ref) return [];
                    return [ref.alt !== (binding.caption ?? '') ? { ...binding, caption: ref.alt } : binding];
                  })
        : undefined;
      const result = await window.wmb.saveStudioCore({ projectId: selected.id, title: editorTitle.trim(), body: editorBody, expectedRevision: selected.revision, mediaBindings: coreSaveBindings });
      setMessage(result.ok ? '已保存' : result.error?.code === 'REVISION_CONFLICT' ? '内容已在其他位置更新，请读取最新内容后再保存' : result.error?.message || '保存失败');
      if (result.ok) { await reload(); setAnnotationReloadTick((tick) => tick + 1); }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
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
      setMessage(result.ok ? result.data?.task.status === 'needs_user' ? result.data.task.errorMessage || '需要用户处理' : 'Pi 初稿任务已完成' : result.error?.message || '初稿失败');
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

  const readCurrentSelection = (): StudioSelectionSnapshot | null => {
    if (!annotationsEditable) return null;
    if (editorMode === 'source') {
      const textarea = sourceInput.current;
      if (!textarea) return null;
      const trimmed = trimToNonWhitespace(editorBody, textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
      if (!trimmed) return null;
      return { ...trimmed, basis: editorBody };
    }
    const editor = bodyInput.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    if (!range.toString().trim()) return null;
    const mapping = richMapping(editor);
    const start = bodyOffsetAtDomPoint(mapping, range.startContainer, range.startOffset, annotationLeadingTitleLen);
    const end = bodyOffsetAtDomPoint(mapping, range.endContainer, range.endOffset, annotationLeadingTitleLen);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      basis: editorBody.slice(0, annotationLeadingTitleLen) + mapping.canonical
    };
  };

  const createAnnotationAt = async (snapshot: StudioSelectionSnapshot, note: string | null) => {
    if (!selected || !annotationScope || annotationBusy || readOnlyVersion) return;
    const validation = validateAnnotationSelection(snapshot.basis, snapshot.start, snapshot.end, openAnnotationRows);
    if (!validation.ok) {
      setMessage(validation.reason === 'overlap' ? '所选文字已有问题标记，请先编辑或移除原标记' : validation.reason === 'heading' ? '标题不能添加问题标记' : '请拖选非空白正文文字后再标记');
      return;
    }
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.createStudioAnnotation({
        ...annotationScope,
        body: editorBody,
        startOffset: snapshot.start,
        endOffset: snapshot.end,
        note: note?.trim() ? note.trim() : null
      });
      if (result.ok) {
        setAnnotationRows((rows) => [result.data, ...rows.filter((row) => row.id !== result.data.id)]);
        rowsScopeKeyRef.current = annotationScopeKeyValue;
        // 后端 rows 现已与当前正文一致：取消挂起的增量 reconcile，避免把新行按旧正文迁移
        window.clearTimeout(reconcileTimer.current);
        backendBodyRef.current = editorBody;
        setContextPanelTab('annotations');
        setSelectedAnnotationId(result.data.id);
        setMessage('已添加问题标记');
      } else {
        setMessage(result.error?.message || '创建失败，请重试');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const updateAnnotationNote = async (annotationId: string, note: string | null) => {
    const row = annotationRows.find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.updateStudioAnnotation({ id: annotationId, expectedRevision: row.revision, note: note?.trim() ? note.trim() : null });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => (item.id === result.data.id ? result.data : item)));
        setMessage('批注说明已更新');
      } else if (result.error?.code === 'REVISION_CONFLICT') {
        setMessage('批注已在其他位置更新，已重新读取');
        reloadAnnotations();
      } else {
        setMessage(result.error?.message || '更新失败');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const removeAnnotation = async (annotationId: string) => {
    const row = annotationRows.find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.resolveStudioAnnotation({ id: annotationId, expectedRevision: row.revision, reason: 'user_removed' });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => (item.id === result.data.id ? result.data : item)));
        setMessage('已移除标记');
      } else if (result.error?.code === 'REVISION_CONFLICT') {
        setMessage('批注已在其他位置更新，已重新读取');
        reloadAnnotations();
      } else {
        setMessage(result.error?.message || '移除失败');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const reopenAnnotation = async (annotationId: string) => {
    const row = annotationRows.find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.reopenStudioAnnotation({ id: annotationId, expectedRevision: row.revision, body: editorBody });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => (item.id === result.data.id ? result.data : item)));
        setMessage('批注已重新打开');
      } else {
        setMessage(result.error?.message || '无法重新打开：原文未在当前正文中唯一定位，请重新选择文字创建标记');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const selectAnnotationFromBody = (annotationId: string) => {
    setSelectedAnnotationId(annotationId);
    setContextPanelTab('annotations');
  };

  const locateAnnotation = (annotationId: string) => {
    setHistoryOpen(false);
    setSelectedAnnotationId(annotationId);
    setFlashAnnotationId(annotationId);
    window.setTimeout(() => setFlashAnnotationId((current) => (current === annotationId ? null : current)), 1400);
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const marker = document.querySelector<HTMLElement>(`[data-studio-annotation-id="${annotationId}"]`);
      if (marker) { marker.scrollIntoView({ block: 'center', behavior }); return; }
      const mirror = document.querySelector<HTMLElement>(`[data-annotation-mirror-id="${annotationId}"]`);
      mirror?.scrollIntoView({ block: 'center', behavior });
    }));
  };

  const markSelection = async () => {
    const snapshot = readCurrentSelection();
    if (!snapshot) { setMessage('请先拖选要标记的文字'); return; }
    await createAnnotationAt(snapshot, null);
  };

  const openAnnotationMenu = (annotationId: string, x: number, y: number) => {
    setAnnotationMenu({ x, y, kind: 'edit', annotationId });
  };

  const handleEditorContextMenu = (event: React.MouseEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    if (!annotationsEditable || !annotationScope) return;
    const markerId = (event.target as HTMLElement).closest('[data-studio-annotation-id]')?.getAttribute('data-studio-annotation-id');
    if (markerId) {
      event.preventDefault();
      setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: 'edit', annotationId: markerId });
      return;
    }
    if (editorMode === 'source') {
      const hit = sourceHitTestRef.current?.(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: 'edit', annotationId: hit });
        return;
      }
    }
    const snapshot = readCurrentSelection();
    if (!snapshot) return;
    const validation = validateAnnotationSelection(snapshot.basis, snapshot.start, snapshot.end, openAnnotationRows);
    if (!validation.ok) {
      if (validation.reason === 'overlap') {
        event.preventDefault();
        setMessage('所选文字已有问题标记，请先编辑或移除原标记');
      }
      return;
    }
    event.preventDefault();
    setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: 'create', snapshot });
  };

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
      // 富文本 / 只读历史 / 源码预览：按标题文本定位
      const roots = [
        bodyInput.current,
        canvas?.querySelector('.studio-live-false-body') as HTMLElement | null
      ].filter(Boolean) as HTMLElement[];
      for (const root of roots) {
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
    <div className="studio-library-body">
      {creating && <div className="studio-create-row"><input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createProject(); }} placeholder="输入新项目标题"/><button className="primary-button" disabled={!newTitle.trim() || busy} onClick={() => void createProject()}>创建并开始写作</button><button className="secondary-button" onClick={() => { setCreating(false); setNewTitle(''); }}>取消</button></div>}
      <div className="studio-library-tools">
        <label className="studio-search-wrap">⌕ <input className="studio-search" type="search" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索项目标题或正文" aria-label="搜索内容项目"/></label>
        <select aria-label="项目排序" value={order} onChange={(event) => setOrder(event.target.value as ContentProjectOrder)}><option value="recent">最近更新</option><option value="oldest">最早更新</option><option value="versions">版本最多</option></select>
        <select aria-label="平台筛选" value={platform ?? 'all'} onChange={(event) => setPlatform(event.target.value === 'all' ? undefined : event.target.value as ContentProjectPlatform)}><option value="all">全部平台</option>{enabledPlatforms.map((value) => <option key={value} value={value}>{platformNames[value]}</option>)}</select>
        <span>找到 {projects.length}{hasMore || offset ? '+' : ''} 个项目</span>
      </div>
      <div className="studio-project-table" role="table">
        <div className="studio-project-row head" role="row"><span>项目</span><span>工作状态</span><span>平台内容</span><span>最近更新</span><span>版本</span><span/></div>
        {projects.map((project) => <div className={`studio-project-row${listFocusId === project.id ? ' selected' : ''}`} role="row" tabIndex={0} key={project.id}
          title={listFocusId === project.id ? '再次点击取消 Pi 焦点；双击或点「打开」进入编辑' : '单击设为 Pi 焦点；双击或点「打开」进入编辑'}
          onClick={() => setListFocusId((current) => current === project.id ? null : project.id)}
          onDoubleClick={() => onSelect(project.id)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter') { event.preventDefault(); onSelect(project.id); }
            if (event.key === ' ') { event.preventDefault(); setListFocusId((current) => current === project.id ? null : project.id); }
          }}>
          <span className="studio-project-title-cell"><span className="studio-project-title-line">{(() => { const g = priorityGrade(project.planItemPriority as number | null | undefined); const n = Number(project.planItemPriority); return Number.isFinite(n) ? <strong className="opp-grade" data-grade={g}>{g}</strong> : null; })()}<button type="button" className="studio-project-name" onClick={(event) => { event.stopPropagation(); onSelect(project.id); }}>{project.title}</button></span><small>项目 {project.id.slice(0, 8)} · 最新正文按需读取</small></span>
          <span className="studio-project-state"><i data-status={project.status}/>{project.archivedAt ? '已归档' : statuses.find((item) => item.value === project.status)?.label}</span>
          <span className="studio-project-platform">{enabledPlatforms.filter((value) => project.platforms[value] > 0).length} / {enabledPlatforms.length}<i><b style={{ width: `${enabledPlatforms.filter((value) => project.platforms[value] > 0).length / Math.max(1, enabledPlatforms.length) * 100}%` }}/></i></span>
          <time>{formatTime(project.updatedAt)}</time>
          <span>{project.versionCount} 个版本</span>
          <span className="studio-row-actions">
            <button className="studio-row-action" aria-label={`打开项目 ${project.title}`} onClick={(event) => { event.stopPropagation(); onSelect(project.id); }}>打开</button>
            <button className="studio-row-action" aria-label={`${project.archivedAt ? '恢复' : '归档'}项目 ${project.title}`} onClick={(event) => { event.stopPropagation(); void archiveRow(project); }}>{project.archivedAt ? '恢复' : '归档'}</button>
            {Object.values(project.platforms).every((count) => !count) && <button className="studio-row-action danger" aria-label={`删除项目 ${project.title}`} onClick={(event) => { event.stopPropagation(); void deleteRow(project); }}>删除</button>}
          </span>
        </div>)}
      </div>
      {loading && !projects.length && <p className="studio-loading">正在读取项目…</p>}
      {!loading && !projects.length && <div className="compact-empty"><h2>没有符合条件的项目</h2><p>调整搜索或状态条件后重试。</p></div>}
      <footer className="studio-library-pagination"><span>第 {projects.length ? offset + 1 : 0}–{offset + projects.length} 项，每页最多 50 项</span><div><button className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button className="secondary-button" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>下一页</button></div></footer>
    </div>
  </section>;
  }

  return <section className="studio-editor-view">
    <input ref={imageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImageFile(file); }}/>
    <input ref={replaceImageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void replaceAssetImage(file); }}/>
    <StudioEditorTop selected={selected} dirty={dirty} latestCreatedAt={activePlatformVersion?.updatedAt ?? latest?.createdAt} documentLabel={activePlatform ? `${platformNames[activePlatform]} · ${activePlatformVersion ? `版本 ${activePlatformVersion.revision}` : '新版本'}` : undefined} onBack={() => onSelect(null)} onToggleHistory={() => setHistoryOpen((value) => !value)} historyOpen={historyOpen} viewedVersion={Boolean(readOnlyVersion)} editorMode={editorMode} setEditorMode={setEditorMode} busy={busy} save={save} preparePublication={activePlatform === 'zhihu' && activePlatformVersion ? prepareZhihuPublication : undefined} prepareLabel="准备发布知乎" prepareDisabled={dirty}/>
    <div className="studio-editor-grid">
    <StudioOutline outline={outline} tab={tab} setTab={setTab} platformVersions={selected?.platformVersions ?? {}} onJumpToStart={jumpToStart} onJumpToHeading={jumpToHeading}/>
    <main className="studio-document">
      {selected ? <>
        {editorTab && <>
          {readOnlyVersion && <section className="historical-version-notice"><span>正在查看不可修改的版本 v{readOnlyVersion.number}</span><div><button className="secondary-button" onClick={() => setViewedVersionId(null)}>返回最新版</button><button className="secondary-button" disabled={busy} onClick={() => void saveFromVersion()}>基于此版本另存</button></div><label>新项目标题<input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)}/></label><button className="primary-button" disabled={busy || !copyTitle.trim()} onClick={() => void copyVersion()}>复制版本为新项目</button></section>}
          {!readOnlyVersion && <StudioFormatBar busy={busy} execRich={execRich} formatSelection={formatSelection} insertMarkdown={insertMarkdown} insertImageFile={insertImageFile} toggleFind={() => setFindOpen((value) => !value)} onMarkSelection={() => { void markSelection(); }} canMark={annotationsEditable}/>} 
          {findOpen && !readOnlyVersion && <div className="studio-findbar"><input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="查找正文"/><input id="studio-replace" placeholder="替换为"/><span>{findText ? editorBody.split(findText).length - 1 : 0} 处匹配</span><button disabled={!findText || !editorBody.includes(findText)} onClick={() => { const replacement = (document.querySelector('#studio-replace') as HTMLInputElement)?.value ?? ''; changeBody(editorBody.split(findText).join(replacement)); }}>全部替换</button><button onClick={() => setFindOpen(false)}>关闭</button></div>}
          <div className="studio-canvas" ref={canvasRef}><article className="studio-paper">
            <textarea id="studio-title" className="studio-title-input" value={editorTitle} rows={1} disabled={busy || Boolean(readOnlyVersion)} placeholder={activePlatform ? '输入平台标题（可选）' : undefined} onChange={(event) => changeEditorTitle(event.target.value)} onInput={(event) => { const el = event.currentTarget; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }} ref={(node) => { if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }}/>
            {readOnlyVersion || editorMode === 'rich' ? (
              <div className="studio-rich-annotate-wrap" ref={richWrapRef}>
                <div
                  ref={(node) => {
                    bodyInput.current = node;
                    if (node && (readOnlyVersion || editorMode === 'rich')) {
                      const html = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
                      if (node.innerHTML !== html) node.innerHTML = html;
                    }
                  }}
                  id="studio-body"
                  className="studio-rich-editor"
                  contentEditable={!readOnlyVersion && !busy && editorMode === 'rich'}
                  suppressContentEditableWarning
                  onInput={(event) => changeBody(htmlToMarkdown(event.currentTarget))}
                  onPaste={handleEditorPaste}
                  onContextMenu={handleEditorContextMenu}
                  onClick={handleInlineFigureClick}
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
                <section className="studio-live-false" aria-label="Markdown 实时预览">
                  <div className="studio-live-false-label">实时预览</div>
                  <div
                    className="studio-rich-editor studio-live-false-body"
                    onClick={handleInlineFigureClick}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyWithoutLeadingTitle(editorBody)) || '<p class="studio-live-false-empty">输入 Markdown 后这里会实时渲染</p>' }}
                  />
                </section>
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
            <span className={message ? 'studio-status-message' : undefined}>
              {message || (readOnlyVersion ? '历史版本只读' : dirty ? '未保存' : anyDirty ? '其他页签有未保存修改' : '已保存')}
            </span>
          </div>
        </>}
        {tab === 'sources' && <section className="studio-detail-list">{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><span>资料来源</span><h3>{source.title}</h3><p>{source.summary || '暂无摘要'}</p><small className="studio-source-meta"><SourcePlatformMark canonicalUrl={source.canonicalUrl} aiSourcePresentation={aiSourcePresentation}/><span>{[source.author, source.publishedAt && formatTime(source.publishedAt)].filter(Boolean).join(' · ')}</span></small>{source.canonicalUrl && <button className="secondary-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}</article>) : <div className="compact-empty"><h2>没有关联资料</h2><p>该项目尚未绑定资料来源。</p></div>}</section>}
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
