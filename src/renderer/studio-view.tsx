import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentProjectDetail, ContentProjectOrder, ContentProjectPlatform, ContentProjectStatus, ContentProjectStatusSummary, ContentProjectSummary } from '../main/content';
import type { StudioAnnotation, StudioDocumentScope } from '../shared/studio-annotations';
import { bodyWithoutLeadingTitle, formatTime, htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, platformNames, renderMarkdown, statuses, wrapTextareaSelection } from './studio-view-helpers';
import { StudioContext, StudioEditorTop, StudioFormatBar, StudioLibraryHeader, StudioOutline } from './studio-view-panels';
import { createStudioPlatformDraft, isStudioPlatformDraftDirty, selectStudioPlatformVersion, studioPlatformDraftKey, studioPlatformFromTab, type StudioPlatformDraft, type StudioTab } from './studio-platform-tabs';
import { annotationContextAround, annotationScopeKey, computeBodyFingerprint, leadingTitleLength, trimToNonWhitespace, validateAnnotationSelection, shiftAnnotationRanges, type StudioAnnotationRow } from './studio-annotations';
import { StudioAnnotationMenu, StudioAnnotationNoteInput, StudioAnnotationOverlay, bodyOffsetAtDomPoint, richMapping, type SourceHitTest } from './studio-annotation-layer';
import { appConfirm } from './app-confirm';
import { priorityGrade } from './today-view-parts';

type StudioSelectionSnapshot = { start: number; end: number; basis: string };
type StudioFocusObject = {
  type: string; id: string; title: string; summary?: string | null;
  bodyStatus?: 'none' | 'ready' | 'failed' | 'empty'; bodyExcerpt?: string | null; bodyChars?: number;
  studioDocument?: { projectId: string; documentKind: 'core' | 'platform'; documentId: string | null; platform: 'x' | 'xiaohongshu' | 'wechat' | null; title: string; currentBody: string; bodyFingerprint: string; dirty: boolean };
  openAnnotations?: Array<Pick<StudioAnnotation, 'id' | 'startOffset' | 'endOffset' | 'quotedText' | 'prefixContext' | 'suffixContext' | 'note'>>;
};
export function LongTermStudioView({ openPublish, selectedId, onSelect, onContext, onFocusChange, onOpenSource, planDate, enabledPlatforms }: {
  openPublish: () => void; selectedId: string | null; onSelect: (projectId: string | null) => void;
  onContext: (project: { id: string; title: string } | null) => void;
  onFocusChange?: (focus: StudioFocusObject | null) => void;
  onOpenSource?: (sourceId: string) => void;
  planDate: string; enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat'>;
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
  const [contextOpen, setContextOpen] = useState(false); const [editorMode, setEditorMode] = useState<'rich' | 'source'>('source');
  const [creating, setCreating] = useState(false); const [newTitle, setNewTitle] = useState('');
  const bodyInput = useRef<HTMLDivElement>(null); const sourceInput = useRef<HTMLTextAreaElement>(null);
  const richWrapRef = useRef<HTMLDivElement>(null); const sourceWrapRef = useRef<HTMLDivElement>(null);
  const sourceHitTestRef = useRef<SourceHitTest | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useRef<HTMLInputElement>(null); const importInput = useRef<HTMLInputElement>(null);
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
  const coreDirty = Boolean(selected) && (title.trim() !== selected?.title.trim() || body !== (latest?.body ?? ''));
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

  useEffect(() => { if (!contextOpen) return; const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextOpen(false); }; window.addEventListener('keydown', handleKeyDown); return () => window.removeEventListener('keydown', handleKeyDown); }, [contextOpen]);
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
  useEffect(() => {
    if (!editorTab) return;
    if (editorMode !== 'rich' && !readOnlyVersion) return;
    const editor = bodyInput.current;
    if (!editor) return;
    if (document.activeElement === editor && editorMode === 'rich' && !readOnlyVersion) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
  }, [tab, editorTab, displayBody, readOnlyVersion?.id, editorMode]);
  useEffect(() => {
    if (!editorTab) return;
    if (!(readOnlyVersion || editorMode === 'rich')) return;
    const editor = bodyInput.current;
    if (!editor) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
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
  const updateActivePlatformDraft = (change: Partial<{ title: string; body: string; assetIds: string[] }>) => {
    if (!activePlatformDraftKey) return;
    setPlatformDrafts((current) => {
      const previous = current[activePlatformDraftKey] ?? createStudioPlatformDraft(activePlatformVersion);
      return { ...current, [activePlatformDraftKey]: { ...previous, ...change } };
    });
  };
  const applyEditorBody = (next: string) => activePlatform ? updateActivePlatformDraft({ body: next }) : setBody(next);
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
    if (annotationScope && rowsScopeKeyRef.current === annotationScopeKeyValue) {
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
        const result = await window.wmb.saveStudioPlatform({
          projectId: selected.id,
          contentVersionId: activePlatformVersion?.contentVersionId ?? latest.id,
          platform: activePlatform,
          format: activePlatformVersion?.format ?? 'text',
          title: editorTitle.trim() || undefined,
          body: editorBody,
          assetIds: activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? [],
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
        const detail = await window.wmb.getStudioProject(selected.id); if (detail) setSelected(detail);
        await loadFirst(true);
        setAnnotationReloadTick((tick) => tick + 1);
        setMessage(`已保存${platformNames[activePlatform]}平台版本 · 版本 ${result.data.revision}`);
        return;
      }
      const result = await window.wmb.saveStudioCore({ projectId: selected.id, title: editorTitle.trim(), body: editorBody, expectedRevision: selected.revision });
      setMessage(result.ok ? '已保存' : result.error?.code === 'REVISION_CONFLICT' ? '内容已在其他位置更新，请读取最新内容后再保存' : result.error?.message || '保存失败');
      if (result.ok) { await reload(); setAnnotationReloadTick((tick) => tick + 1); }
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

  return <section className={`studio-editor-view${contextOpen ? ' context-open' : ''}`}>
    <input ref={imageInput} className="studio-import-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImageFile(file); }}/>
    <StudioEditorTop selected={selected} dirty={dirty} latestCreatedAt={activePlatformVersion?.updatedAt ?? latest?.createdAt} documentLabel={activePlatform ? `${platformNames[activePlatform]} · ${activePlatformVersion ? `版本 ${activePlatformVersion.revision}` : '新版本'}` : undefined} onBack={() => onSelect(null)} toggleContext={() => setContextOpen((value) => !value)} viewedVersion={Boolean(readOnlyVersion)} editorMode={editorMode} setEditorMode={setEditorMode} busy={busy} save={save}/>
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
            <div className="studio-doc-meta">
              <span>{activePlatform ? `${platformNames[activePlatform]} · ${activePlatformVersion?.format ?? 'text'}` : '核心正文'}</span>
              <span>{activePlatform ? activePlatformVersion ? `版本 ${activePlatformVersion.revision}` : '首版未保存' : statuses.find((item) => item.value === selected.status)?.label}</span>
              <span>{selected.sources.length} 条来源</span>
              {selected.creativeBrief && <span>来自创作简报</span>}
              <span>{activePlatform ? activePlatformDraft?.assetIds.length ?? activePlatformVersion?.assets.length ?? 0 : selected.assets.length} 个素材</span>
              <span>{editorMode === 'source' ? 'Markdown 源码' : '富文本'}</span>
            </div>
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
                  onBlur={(event) => {
                    if (readOnlyVersion || editorMode !== 'rich') return;
                    event.currentTarget.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(editorBody));
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
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyWithoutLeadingTitle(editorBody)) || '<p class="studio-live-false-empty">输入 Markdown 后这里会实时渲染</p>' }}
                  />
                </section>
              </div>
            )}
          </article></div>
          <div className="studio-writing-status" data-running={busy ? 'true' : 'false'}>
            <div className="studio-status-left">
              <span className="studio-status-metrics">字数 {characterCount} · 约 {Math.max(1, Math.ceil(characterCount / 500))} 分钟</span>
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
              </div>
            </div>
            <span className={message ? 'studio-status-message' : undefined}>
              {message || (readOnlyVersion ? '历史版本只读' : dirty ? '未保存' : anyDirty ? '其他页签有未保存修改' : '已保存')}
            </span>
          </div>
        </>}
        {tab === 'sources' && <section className="studio-detail-list">{selected.sources.length ? selected.sources.map((source) => <article key={source.id}><span>资料来源</span><h3>{source.title}</h3><p>{source.summary || '暂无摘要'}</p><small>{[source.author, source.publishedAt && formatTime(source.publishedAt)].filter(Boolean).join(' · ')}</small>{source.canonicalUrl && <button className="secondary-button" onClick={() => void window.wmb.openExternal(source.canonicalUrl!)}>打开原文 ↗</button>}</article>) : <div className="compact-empty"><h2>没有关联资料</h2><p>该项目尚未绑定资料来源。</p></div>}</section>}
        {tab === 'assets' && <section className="studio-detail-list">{selected.assets.length ? selected.assets.map((asset) => <article key={asset.id}><span>{asset.mimeType}</span><h3>{asset.relativePath}</h3><p>素材指纹 {asset.sha256}</p><small>{asset.byteCount} 字节{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}{asset.durationMs ? ` · ${asset.durationMs} 毫秒` : ''} · {asset.origin}</small></article>) : <div className="compact-empty"><h2>没有关联素材</h2><p>只有被平台版本真实引用的素材才会显示。</p></div>}</section>}
      </> : <section className="empty-state editor-empty"><h2>{message ? '项目详情读取失败' : '选择一个内容项目'}</h2><p>{message || '左侧会显示符合当前条件的项目。'}</p>{selectedId && message && <button onClick={() => void loadDetail(selectedId)}>重新读取</button>}</section>}
    </main>
    <StudioContext selected={selected} setTab={setTab} setViewedVersionId={setViewedVersionId} latestId={latest?.id} activePlatform={activePlatform} selectedPlatformVersionId={activePlatform ? platformSelections[activePlatform] ?? activePlatformVersion?.id : null} setSelectedPlatformVersionId={(value) => { if (activePlatform) setPlatformSelections((current) => ({ ...current, [activePlatform]: value })); }} annotationView={{
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
    }}/>
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
    </div>
  </section>;
}
