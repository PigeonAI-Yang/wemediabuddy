"use strict";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bodyWithoutLeadingTitle, contentMediaLayoutMap, formatAssetSize, formatTime, htmlToMarkdown, insertTextAtCursor, looksLikeMarkdown, parseAssetImages, platformNames, removeAssetImageToken, renderMarkdown, replaceAssetImageToken, statuses, updateAssetImageAlt, updateContentMediaBinding, wrapTextareaSelection } from "./studio-view-helpers";
import { StudioContext, StudioEditorTop, StudioFormatBar, StudioLibraryHeader, StudioOutline } from "./studio-view-panels";
import { StudioImageCropDialog } from "./studio-image-crop";
import { buildAssetIdsFromPlatformBindings, contentBindingKey } from "../shared/media-bindings";
import { createStudioPlatformDraft, isStudioPlatformDraftDirty, platformBindingsToDrafts, platformMediaBindingsEqual, readPlatformVersionBindings, selectStudioPlatformVersion, setPlatformBindingCaption, studioPlatformDraftKey, studioPlatformFromTab, syncPlatformBindingsToRefs } from "./studio-platform-tabs";
import { annotationContextAround, annotationScopeKey, computeBodyFingerprint, leadingTitleLength, trimToNonWhitespace, validateAnnotationSelection, shiftAnnotationRanges } from "./studio-annotations";
import { StudioAnnotationMenu, StudioAnnotationNoteInput, StudioAnnotationOverlay, bodyOffsetAtDomPoint, richMapping } from "./studio-annotation-layer";
import { appConfirm } from "./app-confirm";
import { priorityGrade } from "./today-view-parts";
function coreBindingsFromDetail(detail) {
  const latest = detail?.revisions[0];
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
function coreMediaBindingsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.assetId !== y.assetId || x.occurrence !== y.occurrence || x.widthPreset !== y.widthPreset || x.align !== y.align || (x.caption ?? null) !== (y.caption ?? null) || (x.linkUrl ?? null) !== (y.linkUrl ?? null)) return false;
  }
  return true;
}
export function LongTermStudioView({ openPublish, selectedId, onSelect, onContext, onFocusChange, onOpenSource, planDate, enabledPlatforms }) {
  const [projects, setProjects] = useState([]);
  const [topics, setTopics] = useState([]);
  const [listFocusId, setListFocusId] = useState(null);
  const [statusSummary, setStatusSummary] = useState(null);
  const [selected, setSelected] = useState(null);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState();
  const [archived, setArchived] = useState(false);
  const [order, setOrder] = useState("recent");
  const [platform, setPlatform] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tab, setTab] = useState("core");
  const [platformSelections, setPlatformSelections] = useState({});
  const [platformDrafts, setPlatformDrafts] = useState({});
  const [contextTab, setContextTab] = useState("versions");
  const [viewedVersionId, setViewedVersionId] = useState(null);
  const [annotationRows, setAnnotationRows] = useState([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [annotationsError, setAnnotationsError] = useState(null);
  const [annotationReloadTick, setAnnotationReloadTick] = useState(0);
  const [contextPanelTab, setContextPanelTab] = useState("versions");
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
  const [flashAnnotationId, setFlashAnnotationId] = useState(null);
  const [annotationMenu, setAnnotationMenu] = useState(null);
  const [noteInput, setNoteInput] = useState(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const annotationBasisRef = useRef("");
  const backendBodyRef = useRef("");
  const rowsScopeKeyRef = useRef("");
  const reconcileTimer = useRef(void 0);
  const annotationSyncGuardRef = useRef(0);
  const pendingExternalReplaceRef = useRef(false);
  const annotationSyncPromiseRef = useRef(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [editorMode, setEditorMode] = useState("source");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const bodyInput = useRef(null);
  const sourceInput = useRef(null);
  const richWrapRef = useRef(null);
  const sourceWrapRef = useRef(null);
  const sourceHitTestRef = useRef(null);
  const canvasRef = useRef(null);
  const imageInput = useRef(null);
  const importInput = useRef(null);
  const imageMenuButtonRef = useRef(null);
  const imageMenuRef = useRef(null);
  const replaceImageInput = useRef(null);
  const pendingReplaceRef = useRef(null);
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const [imageMenuRect, setImageMenuRect] = useState(null);
  const [imageMenuEditKey, setImageMenuEditKey] = useState(null);
  const [imageMenuAltDrafts, setImageMenuAltDrafts] = useState({});
  const [imageMenuBusyIndex, setImageMenuBusyIndex] = useState(null);
  const [cropTarget, setCropTarget] = useState(null);
  const [platformCropPayloads, setPlatformCropPayloads] = useState({});
  const [coreMediaDraft, setCoreMediaDraft] = useState([]);
  const [coreMediaBase, setCoreMediaBase] = useState([]);
  const [inlineSelection, setInlineSelection] = useState(null);
  const bodyHistory = useRef([""]);
  const bodyHistoryIndex = useRef(0);
  const latest = selected?.revisions[0];
  const viewedVersion = selected?.revisions.find((version) => version.id === viewedVersionId) ?? null;
  const activePlatform = studioPlatformFromTab(tab);
  const activePlatformVersion = activePlatform ? selectStudioPlatformVersion(selected?.platformVersions[activePlatform] ?? [], platformSelections[activePlatform]) : null;
  const activePlatformDraftKey = activePlatform ? studioPlatformDraftKey(activePlatform, activePlatformVersion) : null;
  const activePlatformDraft = activePlatformDraftKey ? platformDrafts[activePlatformDraftKey] : void 0;
  const editorTitle = activePlatform ? activePlatformDraft?.title ?? activePlatformVersion?.title ?? "" : title;
  const editorBody = activePlatform ? activePlatformDraft?.body ?? activePlatformVersion?.body ?? "" : body;
  const coreDirty = Boolean(selected) && (title.trim() !== selected?.title.trim() || body !== (latest?.body ?? "") || !coreMediaBindingsEqual(coreMediaDraft, coreMediaBase));
  const dirty = activePlatform ? Boolean(activePlatformDraft && isStudioPlatformDraftDirty(activePlatformDraft)) : coreDirty;
  const anyDirty = coreDirty || Object.values(platformDrafts).some(isStudioPlatformDraftDirty);
  const annotationScope = useMemo(() => {
    if (!selected) return null;
    if (activePlatform) {
      return {
        projectId: selected.id,
        documentKind: "platform",
        documentId: activePlatformVersion?.id ?? activePlatformVersion?.contentVersionId ?? latest?.id ?? null,
        platform: activePlatform
      };
    }
    return { projectId: selected.id, documentKind: "core", documentId: latest?.id ?? null, platform: null };
  }, [selected, activePlatform, activePlatformVersion?.id, activePlatformVersion?.contentVersionId, latest?.id]);
  const annotationScopeKeyValue = annotationScope ? annotationScopeKey(annotationScope) : "";
  const openAnnotationRows = useMemo(() => annotationRows.filter((row) => row.status === "open"), [annotationRows]);
  const visibleOpenAnnotations = rowsScopeKeyRef.current === annotationScopeKeyValue ? openAnnotationRows : [];
  const annotationLeadingTitleLen = leadingTitleLength(editorBody);
  const annotationVersionCount = activePlatform ? selected?.platformVersions[activePlatform]?.length ?? 0 : selected?.revisions.length ?? 0;
  const input = { query: query || void 0, status, archived, order, platform, limit: 50 };
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
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  const loadDetail = async (id) => {
    try {
      const detail = await window.wmb.getStudioProject(id);
      setSelected(detail);
      setTitle(detail?.title ?? "");
      const latestBody = detail?.revisions[0]?.body ?? "";
      setBody(latestBody);
      bodyHistory.current = [latestBody];
      bodyHistoryIndex.current = 0;
      setViewedVersionId(null);
      setMessage(detail ? "" : "\u9879\u76EE\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    if (!contextOpen) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setContextOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [contextOpen]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);
  useEffect(() => {
    const requestImport = () => importInput.current?.click();
    window.addEventListener("studio-import-request", requestImport);
    return () => window.removeEventListener("studio-import-request", requestImport);
  }, []);
  useEffect(() => {
    void loadFirst();
  }, [query, status, archived, order, platform, offset]);
  useEffect(() => {
    return window.wmb.onDataChanged((event) => {
      const scopes = event.scopes ?? [];
      const touchesStudio = scopes.includes("studio") || scopes.includes("agent") || scopes.length === 0;
      if (!touchesStudio) return;
      void loadFirst(true);
      if (selectedId && !anyDirty) {
        if (!event.reason?.split(",").every((reason) => reason.startsWith("studio_annotations."))) pendingExternalReplaceRef.current = true;
        void loadDetail(selectedId);
      }
    });
  }, [query, status, archived, order, platform, offset, anyDirty, selectedId, busy]);
  useEffect(() => {
    void window.wmb.listKnowledgeTopics({ limit: 100 }).then((page) => setTopics(page?.items ?? []));
  }, []);
  useEffect(() => {
    setOffset(0);
  }, [query, status, archived, order, platform]);
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setPlatformSelections({});
      setPlatformDrafts({});
      onContext(null);
    }
  }, [selectedId]);
  const summary = projects.find((item) => item.id === selectedId);
  useEffect(() => {
    if (!selectedId) return;
    if (anyDirty && selected?.id === selectedId) return;
    if (!selected || selected.id !== selectedId || selected.updatedAt !== summary?.updatedAt) void loadDetail(selectedId);
  }, [selectedId, summary?.updatedAt, anyDirty, selected?.id, selected?.updatedAt]);
  useEffect(() => {
    onContext(selected ? { id: selected.id, title: selected.title } : null);
  }, [selected?.id, selected?.title]);
  useEffect(() => {
    if (!onFocusChange) return;
    if (selected) {
      const latestBody = selected.revisions[0]?.body ?? "";
      const excerpt = latestBody.trim() ? latestBody.slice(0, 6e3) : null;
      const rowsCurrent = annotationScopeKeyValue !== "" && rowsScopeKeyRef.current === annotationScopeKeyValue;
      onFocusChange({
        type: "project",
        id: selected.id,
        title: selected.title,
        summary: `\u72B6\u6001 ${selected.status} \xB7 ${selected.revisions.length} \u7248`,
        bodyStatus: excerpt ? "ready" : "empty",
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
        } : void 0,
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
          type: "project",
          id: project.id,
          title: project.title,
          summary: `${project.archivedAt ? "\u5DF2\u5F52\u6863" : project.status} \xB7 ${project.versionCount} \u7248 \xB7 \u5217\u8868\u7126\u70B9\uFF08\u672A\u6253\u5F00\u7F16\u8F91\u5668\uFF09`,
          bodyStatus: "none",
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
    setTitle(selected?.title ?? "");
    const latestBody = selected?.revisions[0]?.body ?? "";
    setBody(latestBody);
    bodyHistory.current = [latestBody];
    bodyHistoryIndex.current = 0;
    setViewedVersionId(null);
    setCopyTitle(selected ? `${selected.title}\uFF08\u72EC\u7ACB\u9879\u76EE\uFF09` : "");
  }, [selected?.id, selected?.title, selected?.revisions[0]?.id]);
  useEffect(() => {
    const bindings = coreBindingsFromDetail(selected);
    setCoreMediaDraft(bindings);
    setCoreMediaBase(bindings);
  }, [selected?.id, selected?.revisions[0]?.id]);
  const readOnlyVersion = tab === "versions" ? viewedVersion : null;
  const annotationsEditable = Boolean(selected && annotationScope && !readOnlyVersion && !busy);
  useEffect(() => {
    if (!annotationScope) {
      rowsScopeKeyRef.current = "";
      setAnnotationRows([]);
      setAnnotationsLoading(false);
      setAnnotationsError(null);
      return;
    }
    const scopeKey = annotationScopeKey(annotationScope);
    let cancelled = false;
    setAnnotationsLoading(true);
    setAnnotationsError(null);
    window.wmb.listStudioAnnotations({ ...annotationScope, includeResolved: true }).then((rows) => {
      if (cancelled) return;
      setAnnotationRows(rows);
      rowsScopeKeyRef.current = scopeKey;
      backendBodyRef.current = editorBody;
      annotationBasisRef.current = editorBody;
    }).catch((error) => {
      if (!cancelled) setAnnotationsError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setAnnotationsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [annotationScopeKeyValue, annotationReloadTick]);
  const currentAnnotationBasis = () => {
    const editor = bodyInput.current;
    if (!editor || editorMode === "source") return editorBody;
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
  }, [editorBody, editorMode, annotationScopeKeyValue, annotationRows]);
  const syncAnnotationsToBody = async (scope, scopeKey, nextBody, mode) => {
    window.clearTimeout(reconcileTimer.current);
    const pending = annotationSyncPromiseRef.current;
    if (pending) await pending;
    if (rowsScopeKeyRef.current !== scopeKey || backendBodyRef.current === nextBody) return true;
    const previousBody = backendBodyRef.current;
    const guard = ++annotationSyncGuardRef.current;
    const request = window.wmb.reconcileStudioAnnotations({ ...scope, previousBody, nextBody, mode }).then((result) => {
      if (!result.ok || guard !== annotationSyncGuardRef.current) return false;
      setAnnotationRows(result.data);
      rowsScopeKeyRef.current = scopeKey;
      backendBodyRef.current = nextBody;
      return true;
    }).catch(() => false);
    annotationSyncPromiseRef.current = request;
    const synced = await request;
    if (annotationSyncPromiseRef.current === request) annotationSyncPromiseRef.current = null;
    return synced;
  };
  useEffect(() => {
    const replace = pendingExternalReplaceRef.current;
    pendingExternalReplaceRef.current = false;
    if (!annotationScope || rowsScopeKeyRef.current !== annotationScopeKeyValue) return;
    if (backendBodyRef.current === editorBody) return;
    const scope = annotationScope;
    const scopeKey = annotationScopeKeyValue;
    if (replace) {
      void syncAnnotationsToBody(scope, scopeKey, editorBody, "replacement");
      return;
    }
    window.clearTimeout(reconcileTimer.current);
    reconcileTimer.current = window.setTimeout(() => {
      if (busy || !selected) return;
      void syncAnnotationsToBody(scope, scopeKey, editorBody, "incremental");
    }, 600);
    return () => window.clearTimeout(reconcileTimer.current);
  }, [editorBody, busy, annotationScopeKeyValue]);
  useEffect(() => () => window.clearTimeout(reconcileTimer.current), []);
  const outline = useMemo(() => bodyWithoutLeadingTitle(editorBody).split("\n").flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2], index }] : [];
  }), [editorBody]);
  const characterCount = editorBody.replace(/\s/g, "").length;
  const displayBody = readOnlyVersion?.body ?? editorBody;
  const editorTab = tab === "core" || tab === "versions" || Boolean(activePlatform);
  const assetImageRefs = useMemo(() => parseAssetImages(displayBody), [displayBody]);
  const assetById = useMemo(() => new Map((selected?.assets ?? []).map((asset) => [asset.id, asset])), [selected?.assets]);
  const platformSyncedBindings = useMemo(() => {
    if (!activePlatform) return [];
    const base = activePlatformDraft?.mediaBindings ?? platformBindingsToDrafts(readPlatformVersionBindings(activePlatformVersion));
    return syncPlatformBindingsToRefs(base, parseAssetImages(editorBody));
  }, [activePlatform, activePlatformDraft?.mediaBindings, activePlatformVersion, editorBody]);
  const platformDisplayBindings = useMemo(() => [...platformSyncedBindings].sort((a, b) => a.ordinal - b.ordinal), [platformSyncedBindings]);
  const currentPlatformBindings = activePlatformDraft?.mediaBindings ?? platformSyncedBindings;
  const mediaLayoutMap = useMemo(() => contentMediaLayoutMap(coreMediaDraft), [coreMediaDraft]);
  const viewedLayoutMap = useMemo(() => contentMediaLayoutMap(viewedVersion?.bindings ?? []), [viewedVersion]);
  const emptyLayoutMap = useMemo(() => /* @__PURE__ */ new Map(), []);
  const activeLayoutMap = activePlatform ? emptyLayoutMap : readOnlyVersion ? viewedLayoutMap : mediaLayoutMap;
  const applyInlineLayout = useCallback((root) => {
    const seenCounts = /* @__PURE__ */ new Map();
    for (const figure of root.querySelectorAll("figure.studio-figure")) {
      const assetId = figure.getAttribute("data-wmb-asset") ?? "";
      if (!assetId) continue;
      const occurrence = seenCounts.get(assetId) ?? 0;
      seenCounts.set(assetId, occurrence + 1);
      const layout = activeLayoutMap.get(contentBindingKey(assetId, occurrence));
      if (layout) {
        figure.setAttribute("data-wmb-width", layout.widthPreset);
        figure.setAttribute("data-wmb-align", layout.align);
      } else {
        figure.removeAttribute("data-wmb-width");
        figure.removeAttribute("data-wmb-align");
      }
    }
  }, [activeLayoutMap]);
  useEffect(() => {
    if (!editorTab) return;
    const roots = [bodyInput.current, ...Array.from(document.querySelectorAll(".studio-live-false-body"))].filter(Boolean);
    for (const root of roots) applyInlineLayout(root);
  }, [editorTab, displayBody, editorMode, readOnlyVersion?.id, applyInlineLayout]);
  useEffect(() => {
    if (!editorTab) return;
    if (editorMode !== "rich" && !readOnlyVersion) return;
    const editor = bodyInput.current;
    if (!editor) return;
    if (document.activeElement === editor && editorMode === "rich" && !readOnlyVersion) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
    applyInlineLayout(editor);
  }, [tab, editorTab, displayBody, readOnlyVersion?.id, editorMode]);
  useEffect(() => {
    if (!editorTab) return;
    if (!(readOnlyVersion || editorMode === "rich")) return;
    const editor = bodyInput.current;
    if (!editor) return;
    editor.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
    applyInlineLayout(editor);
  }, [tab, editorTab, editorMode, readOnlyVersion?.id, displayBody]);
  const fitSourceEditor = () => {
    const textarea = sourceInput.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const minHeight = Math.max(window.innerHeight - 360, 420);
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  };
  useEffect(() => {
    if (!editorTab) return;
    if (editorMode !== "source" || readOnlyVersion) return;
    const id = window.requestAnimationFrame(() => fitSourceEditor());
    return () => window.cancelAnimationFrame(id);
  }, [tab, editorBody, editorMode, readOnlyVersion]);
  useEffect(() => {
    bodyHistory.current = [editorBody];
    bodyHistoryIndex.current = 0;
  }, [selected?.id, tab, activePlatformVersion?.id]);
  const updateActivePlatformDraft = (change) => {
    if (!activePlatformDraftKey) return;
    setPlatformDrafts((current) => {
      const previous = current[activePlatformDraftKey] ?? createStudioPlatformDraft(activePlatformVersion);
      return { ...current, [activePlatformDraftKey]: { ...previous, ...change } };
    });
  };
  const applyEditorBody = (next) => {
    if (activePlatform) {
      updateActivePlatformDraft({ body: next });
      syncPlatformBindingsForBody(next);
    } else {
      setBody(next);
    }
  };
  const changeEditorTitle = (next) => activePlatform ? updateActivePlatformDraft({ title: next }) : setTitle(next);
  const changeBody = (next) => {
    const history = bodyHistory.current.slice(0, bodyHistoryIndex.current + 1);
    if (history[history.length - 1] !== next) history.push(next);
    bodyHistory.current = history;
    bodyHistoryIndex.current = history.length - 1;
    applyEditorBody(next);
  };
  const moveHistory = (direction) => {
    const next = bodyHistoryIndex.current + direction;
    if (next < 0 || next >= bodyHistory.current.length) return;
    bodyHistoryIndex.current = next;
    applyEditorBody(bodyHistory.current[next]);
  };
  const insertMarkdown = (snippet) => {
    if (readOnlyVersion) return;
    if (editorMode === "source") {
      const textarea = sourceInput.current;
      if (!textarea) {
        changeBody(`${editorBody}${editorBody.endsWith("\n") || !editorBody ? "" : "\n\n"}${snippet}`);
        return;
      }
      textarea.focus();
      changeBody(insertTextAtCursor(textarea, snippet));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) {
      changeBody(`${editorBody}${editorBody.endsWith("\n") || !editorBody ? "" : "\n\n"}${snippet}`);
      return;
    }
    editor.focus();
    document.execCommand("insertHTML", false, renderMarkdown(snippet));
    changeBody(htmlToMarkdown(editor));
  };
  const formatSelection = (before, after = before, placeholder = "\u6587\u5B57") => {
    if (readOnlyVersion) return;
    if (editorMode === "source") {
      const textarea = sourceInput.current;
      if (!textarea) return;
      textarea.focus();
      changeBody(wrapTextareaSelection(textarea, before, after, placeholder));
      return;
    }
    const editor = bodyInput.current;
    if (!editor) return;
    editor.focus();
    const command = before === "**" ? "bold" : before === "*" ? "italic" : before === "~~" ? "strikeThrough" : before === "- " ? "insertUnorderedList" : before === "> " ? "formatBlock" : "";
    if (command === "formatBlock") document.execCommand(command, false, "blockquote");
    else if (command) document.execCommand(command);
    else if (before === "## ") document.execCommand("formatBlock", false, "h2");
    else if (before === "### ") document.execCommand("formatBlock", false, "h3");
    else if (before === "[") {
      const url = window.prompt("\u7C98\u8D34\u94FE\u63A5\u5730\u5740");
      if (url) document.execCommand("createLink", false, url);
    } else if (before.startsWith("```")) {
      insertMarkdown(`
\`\`\`
${placeholder}
\`\`\`
`);
      return;
    } else document.execCommand("insertText", false, `${before}${placeholder}${after}`);
    changeBody(htmlToMarkdown(editor));
  };
  const execRich = (command, value) => {
    if (editorMode === "source") {
      if (command === "bold") return formatSelection("**");
      if (command === "italic") return formatSelection("*");
      if (command === "strikeThrough") return formatSelection("~~");
      if (command === "insertUnorderedList") return insertMarkdown("\n- \u5217\u8868\u9879\n");
      if (command === "insertOrderedList") return insertMarkdown("\n1. \u5217\u8868\u9879\n");
      if (command === "formatBlock" && value === "h2") return insertMarkdown("\n## \u4E8C\u7EA7\u6807\u9898\n\n");
      if (command === "formatBlock" && value === "h3") return insertMarkdown("\n### \u4E09\u7EA7\u6807\u9898\n\n");
      if (command === "formatBlock" && value === "blockquote") return insertMarkdown("\n> \u5F15\u7528\n\n");
      if (command === "formatBlock" && value === "p") return insertMarkdown("\n");
      if (command === "undo") return moveHistory(-1);
      if (command === "redo") return moveHistory(1);
      return;
    }
    const editor = bodyInput.current;
    if (!editor || readOnlyVersion) return;
    editor.focus();
    document.execCommand(command, false, value);
    changeBody(htmlToMarkdown(editor));
  };
  const handleEditorPaste = (event) => {
    if (readOnlyVersion || busy) return;
    const editor = bodyInput.current;
    if (!editor) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/"));
    if (file) {
      event.preventDefault();
      void insertImageFile(file);
      return;
    }
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    if (html && !looksLikeMarkdown(text)) return;
    if (!text || !looksLikeMarkdown(text)) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, renderMarkdown(text));
    changeBody(htmlToMarkdown(editor));
  };
  const handleSourcePaste = (event) => {
    if (readOnlyVersion || busy) return;
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    void insertImageFile(file);
  };
  const insertImageFile = async (file) => {
    if (!selected || busy || readOnlyVersion) return;
    setBusy(true);
    setMessage(file ? "\u6B63\u5728\u63D2\u5165\u56FE\u7247\u2026" : "\u9009\u62E9\u56FE\u7247\u2026");
    try {
      let result;
      if (file) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of buffer) binary += String.fromCharCode(byte);
        result = await window.wmb.importStudioImage({
          projectId: selected.id,
          fileName: file.name,
          mimeType: file.type,
          bytesBase64: btoa(binary),
          alt: file.name.replace(/\.[^.]+$/, "")
        });
      } else {
        result = await window.wmb.importStudioImage({ projectId: selected.id });
      }
      if (!result.ok) {
        setMessage(result.cancelled ? "" : "\u63D2\u5165\u56FE\u7247\u5931\u8D25");
        return;
      }
      if (activePlatform) updateActivePlatformDraft({ assetIds: [.../* @__PURE__ */ new Set([...activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? [], result.asset.id])] });
      insertMarkdown(`${result.markdown}

`);
      setMessage(result.reused ? "\u5DF2\u63D2\u5165\u5DF2\u6709\u56FE\u7247\u7D20\u6750" : "\u56FE\u7247\u5DF2\u63D2\u5165");
      const detail = await window.wmb.getStudioProject(selected.id);
      if (detail) setSelected(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (imageInput.current) imageInput.current.value = "";
    }
  };
  const syncPlatformBindingsForBody = (nextBody) => {
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
  };
  const openImageMenu = () => {
    if (assetImageRefs.length === 0) return;
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
  useEffect(() => {
    if (!imageMenuOpen) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeImageMenu();
    };
    const handlePointerDown = (event) => {
      const target = event.target;
      if (imageMenuRef.current?.contains(target)) return;
      if (imageMenuButtonRef.current?.contains(target)) return;
      closeImageMenu();
    };
    const handleViewportChange = () => closeImageMenu();
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [imageMenuOpen]);
  useEffect(() => {
    const onInlineCropRequest = (event) => {
      if (readOnlyVersion || busy) return;
      const detail = event.detail;
      if (!detail || typeof detail.assetId !== "string") return;
      const occurrence = typeof detail.occurrence === "number" ? detail.occurrence : 0;
      const ref = assetImageRefs.find((item) => item.assetId === detail.assetId && item.occurrence === occurrence);
      if (!ref) {
        setMessage("\u627E\u4E0D\u5230\u8981\u88C1\u526A\u7684\u56FE\u7247");
        return;
      }
      openCropAssetImage(ref);
    };
    window.addEventListener("studio-inline-crop-request", onInlineCropRequest);
    return () => window.removeEventListener("studio-inline-crop-request", onInlineCropRequest);
  }, [assetImageRefs, readOnlyVersion, busy]);
  const locateAssetImage = (ref) => {
    setImageMenuEditKey(null);
    if (editorMode === "source" && !readOnlyVersion) {
      const textarea = sourceInput.current;
      if (!textarea) return;
      textarea.focus();
      const lines = editorBody.split("\n");
      const lineIndex = Math.min(lines.length - 1, editorBody.slice(0, ref.start).split("\n").length - 1);
      const ratio = lines.length > 1 ? lineIndex / (lines.length - 1) : 0;
      textarea.scrollTop = Math.max(0, (textarea.scrollHeight - textarea.clientHeight) * ratio);
      try {
        textarea.setSelectionRange(ref.start, ref.end);
      } catch {
      }
      canvasRef.current?.scrollTo({ top: Math.max(0, textarea.offsetTop - 24), behavior: "smooth" });
      return;
    }
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const roots = [bodyInput.current, document.querySelector(".studio-live-false-body")].filter(Boolean);
      for (const root of roots) {
        const figures = [...root.querySelectorAll("figure[data-wmb-asset]")];
        const figure = figures.filter((node) => node.getAttribute("data-wmb-asset") === ref.assetId)[ref.occurrence];
        if (figure) {
          figure.scrollIntoView({ block: "center", behavior });
          figure.classList.add("studio-figure-flash");
          window.setTimeout(() => figure.classList.remove("studio-figure-flash"), 1400);
          return;
        }
      }
    }));
  };
  const requestReplaceAssetImage = (ref) => {
    if (readOnlyVersion || busy) return;
    pendingReplaceRef.current = { assetId: ref.assetId, occurrence: ref.occurrence };
    replaceImageInput.current?.click();
  };
  const replaceAssetImage = async (file) => {
    const pending = pendingReplaceRef.current;
    pendingReplaceRef.current = null;
    if (!selected || !pending || !file || readOnlyVersion) return;
    const pendingIndex = assetImageRefs.findIndex((item) => item.assetId === pending.assetId && item.occurrence === pending.occurrence);
    setImageMenuBusyIndex(pendingIndex);
    setMessage("\u6B63\u5728\u66FF\u6362\u56FE\u7247\u2026");
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of buffer) binary += String.fromCharCode(byte);
      const result = await window.wmb.importStudioImage({
        projectId: selected.id,
        fileName: file.name,
        mimeType: file.type,
        bytesBase64: btoa(binary),
        alt: file.name.replace(/\.[^.]+$/, "")
      });
      if (!result.ok) {
        setMessage(result.cancelled ? "" : "\u66FF\u6362\u56FE\u7247\u5931\u8D25");
        return;
      }
      const next = replaceAssetImageToken(editorBody, pending.assetId, pending.occurrence, result.markdown);
      if (next === editorBody) {
        setMessage("\u627E\u4E0D\u5230\u8981\u66FF\u6362\u7684\u56FE\u7247");
        return;
      }
      changeBody(next);
      syncPlatformBindingsForBody(next);
      setMessage("\u56FE\u7247\u5DF2\u66FF\u6362");
      const detail = await window.wmb.getStudioProject(selected.id);
      if (detail) setSelected(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImageMenuBusyIndex(null);
      if (replaceImageInput.current) replaceImageInput.current.value = "";
    }
  };
  const removeAssetImage = (ref) => {
    if (readOnlyVersion || busy) return;
    const next = removeAssetImageToken(editorBody, ref.assetId, ref.occurrence);
    if (next === editorBody) return;
    changeBody(next);
    syncPlatformBindingsForBody(next);
    setMessage("\u5DF2\u79FB\u51FA\u672C\u6587");
  };
  const startCaptionEdit = (ref) => {
    const key = `${ref.assetId}:${ref.occurrence}`;
    setImageMenuEditKey(key);
    setImageMenuAltDrafts((current) => ({ ...current, [key]: ref.alt }));
  };
  const saveCaptionEdit = (ref) => {
    const key = `${ref.assetId}:${ref.occurrence}`;
    const alt = (imageMenuAltDrafts[key] ?? ref.alt).trim();
    setImageMenuEditKey(null);
    setImageMenuAltDrafts((current) => {
      const next2 = { ...current };
      delete next2[key];
      return next2;
    });
    if (activePlatform) {
      const binding = currentPlatformBindings.find((item) => item.assetId === ref.assetId);
      const nextCaption = alt || null;
      if (binding && (binding.caption ?? null) === nextCaption) return;
      updateActivePlatformDraft({ mediaBindings: setPlatformBindingCaption(currentPlatformBindings, ref.assetId, nextCaption) });
      setMessage(nextCaption ? "\u5E73\u53F0\u56FE\u6CE8\u5DF2\u66F4\u65B0" : "\u5DF2\u6E05\u9664\u5E73\u53F0\u56FE\u6CE8\uFF08\u6CBF\u7528\u6838\u5FC3\u56FE\u6CE8\uFF09");
      return;
    }
    if (alt === ref.alt) return;
    const next = updateAssetImageAlt(editorBody, ref.assetId, ref.occurrence, alt);
    if (next !== editorBody) {
      changeBody(next);
      setMessage("\u56FE\u6CE8\u5DF2\u66F4\u65B0");
    }
  };
  const removePlatformAsset = (assetId) => {
    if (readOnlyVersion || busy) return;
    let next = editorBody;
    while (parseAssetImages(next).some((ref) => ref.assetId === assetId)) {
      const changed = removeAssetImageToken(next, assetId, 0);
      if (changed === next) break;
      next = changed;
    }
    if (next === editorBody) return;
    changeBody(next);
    setPlatformCropPayloads((current) => {
      const nextPayloads = { ...current };
      delete nextPayloads[assetId];
      return nextPayloads;
    });
    setMessage("\u5DF2\u79FB\u51FA\u672C\u6587");
  };
  const openCropAssetImage = (ref) => {
    if (readOnlyVersion || busy) return;
    setImageMenuOpen(false);
    const asset = assetById.get(ref.assetId);
    setCropTarget({
      assetId: ref.assetId,
      occurrence: ref.occurrence,
      alt: ref.alt,
      assetName: asset ? asset.relativePath.split(/[/\\]/).pop() || asset.relativePath : null
    });
  };
  const deriveCropAsset = async (input2) => {
    try {
      const result = await window.wmb.deriveStudioAsset({
        sourceAssetId: input2.sourceAssetId,
        cropRegion: input2.cropRegion,
        pngBase64: input2.pngBase64
      });
      if (result.ok) {
        return { ok: true, assetId: result.data.assetId, reused: result.data.reused, sha256: result.data.sha256, cropRegion: input2.cropRegion };
      }
      return { ok: false, error: result.error?.message || "\u56FE\u7247\u5904\u7406\u5931\u8D25" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const applyCropResult = async (result) => {
    const target = cropTarget;
    if (!target || !selected) throw new Error("\u9879\u76EE\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u88C1\u5207\u3002");
    if (activePlatform) {
      const currentBindings = currentPlatformBindings;
      const targetIndex = currentBindings.findIndex((binding) => binding.assetId === target.assetId);
      const nextBindings = targetIndex >= 0 ? currentBindings.map((binding) => binding.assetId === target.assetId ? { ...binding, cropRegion: result.cropRegion } : binding) : [...currentBindings, { assetId: target.assetId, ordinal: currentBindings.length, isCover: currentBindings.length === 0, cropRegion: result.cropRegion }];
      setPlatformCropPayloads((current) => ({
        ...current,
        [target.assetId]: { assetId: target.assetId, cropRegion: result.cropRegion, pngBase64: result.pngBase64 }
      }));
      updateActivePlatformDraft({ mediaBindings: nextBindings });
      setMessage("\u5DF2\u5E94\u7528\u88C1\u526A\uFF08\u4FDD\u5B58\u5E73\u53F0\u7248\u672C\u65F6\u751F\u6548\uFF09");
    } else {
      if (!result.derivedAssetId) throw new Error("\u56FE\u7247\u5904\u7406\u670D\u52A1\u672A\u8FD4\u56DE\u6D3E\u751F\u56FE");
      const next = replaceAssetImageToken(editorBody, target.assetId, target.occurrence, assetImageToken(target.alt, result.derivedAssetId));
      if (next === editorBody) throw new Error("\u627E\u4E0D\u5230\u8981\u88C1\u526A\u7684\u56FE\u7247");
      changeBody(next);
      syncPlatformBindingsForBody(next);
      setMessage("\u5DF2\u88C1\u526A\u5E76\u66FF\u6362\u5F53\u524D\u56FE\u7247");
      const detail = await window.wmb.getStudioProject(selected.id);
      if (detail) setSelected(detail);
    }
  };
  const findInlineFigure = useCallback((sel) => {
    const roots = [bodyInput.current, ...Array.from(document.querySelectorAll(".studio-live-false-body"))].filter(Boolean);
    for (const root of roots) {
      const figures = [...root.querySelectorAll("figure.studio-figure")].filter((node) => node.getAttribute("data-wmb-asset") === sel.assetId);
      const figure = figures[sel.occurrence];
      if (figure) return figure;
    }
    return null;
  }, []);
  const inlineFigureOccurrence = (root, figure, assetId) => {
    const figures = [...root.querySelectorAll("figure.studio-figure")].filter((node) => node.getAttribute("data-wmb-asset") === assetId);
    return Math.max(0, figures.indexOf(figure));
  };
  const handleInlineFigureClick = (event) => {
    if (!selected) return;
    const target = event.target;
    const figure = target.closest?.("figure.studio-figure");
    if (!figure || !(figure instanceof HTMLElement)) return;
    const assetId = figure.getAttribute("data-wmb-asset");
    if (!assetId) return;
    event.preventDefault();
    const root = figure.closest(".studio-rich-editor") ?? figure.closest(".studio-live-false-body");
    const occurrence = root ? inlineFigureOccurrence(root, figure, assetId) : 0;
    setInlineSelection({ assetId, occurrence });
  };
  const inlineDraft = useMemo(() => {
    if (!inlineSelection || activePlatform) return null;
    const key = contentBindingKey(inlineSelection.assetId, inlineSelection.occurrence);
    const binding = coreMediaDraft.find((item) => contentBindingKey(item.assetId, item.occurrence) === key);
    return binding ? { widthPreset: binding.widthPreset, align: binding.align } : null;
  }, [inlineSelection, activePlatform, coreMediaDraft]);
  const inlineAlt = useMemo(() => {
    if (!inlineSelection) return "";
    return assetImageRefs.find((item) => item.assetId === inlineSelection.assetId && item.occurrence === inlineSelection.occurrence)?.alt ?? "";
  }, [inlineSelection, assetImageRefs]);
  const inlineRefOf = () => {
    if (!inlineSelection) return null;
    return assetImageRefs.find((item) => item.assetId === inlineSelection.assetId && item.occurrence === inlineSelection.occurrence) ?? null;
  };
  const applyCoreMediaBinding = (assetId, occurrence, patch) => {
    setCoreMediaDraft((draft) => updateContentMediaBinding(draft, assetId, occurrence, patch));
  };
  const handleInlineWidth = (preset) => {
    if (!inlineSelection || readOnlyVersion || busy || activePlatform) return;
    applyCoreMediaBinding(inlineSelection.assetId, inlineSelection.occurrence, { widthPreset: preset });
  };
  const handleInlineAlign = (align) => {
    if (!inlineSelection || readOnlyVersion || busy || activePlatform) return;
    applyCoreMediaBinding(inlineSelection.assetId, inlineSelection.occurrence, { align });
  };
  const handleInlineReplace = () => {
    const ref = inlineRefOf();
    if (ref) requestReplaceAssetImage(ref);
  };
  const handleInlineCaption = (alt) => {
    const ref = inlineRefOf();
    if (!ref) return;
    const next = updateAssetImageAlt(editorBody, ref.assetId, ref.occurrence, alt);
    if (next !== editorBody) {
      changeBody(next);
      setMessage("\u56FE\u6CE8\u5DF2\u66F4\u65B0");
    }
  };
  const handleInlineRemove = () => {
    const ref = inlineRefOf();
    if (!ref) return;
    removeAssetImage(ref);
    setInlineSelection(null);
  };
  const handleInlineCrop = () => {
    const ref = inlineRefOf();
    if (ref) openCropAssetImage(ref);
  };
  useEffect(() => {
    if (!inlineSelection || readOnlyVersion || busy) return;
    const onKeyDown = (event) => {
      if (event.key !== "Delete") return;
      const target = event.target;
      if (!target) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      handleInlineRemove();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [inlineSelection, readOnlyVersion, busy, editorBody, displayBody]);
  const createProject = async () => {
    if (!newTitle.trim() || busy) return;
    setBusy(true);
    try {
      const detail = await window.wmb.createStudioProject({ title: newTitle.trim(), body: "\u5F00\u59CB\u5199\u4F5C\u3002" });
      setCreating(false);
      setNewTitle("");
      await loadFirst(true);
      onSelect(detail.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const importProject = async (file) => {
    setBusy(true);
    try {
      const body2 = await file.text();
      const title2 = file.name.replace(/\.(md|markdown|txt)$/i, "").trim() || "\u5BFC\u5165\u7A3F\u4EF6";
      const detail = await window.wmb.createStudioProject({ title: title2, body: body2.trim() || "\u5F00\u59CB\u5199\u4F5C\u3002" });
      await loadFirst(true);
      onSelect(detail.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  };
  const reload = async () => {
    if (selectedId) await loadDetail(selectedId);
    await loadFirst(true);
  };
  const deleteRow = async (project) => {
    if (busy) return;
    if (!await appConfirm({ title: "\u5220\u9664\u9879\u76EE", message: `\u5F7B\u5E95\u5220\u9664\u9879\u76EE\u300C${project.title}\u300D\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002`, confirmLabel: "\u5F7B\u5E95\u5220\u9664", danger: true })) return;
    setBusy(true);
    try {
      const result = await window.wmb.deleteStudioProject({ projectId: project.id, expectedRevision: project.revision });
      setMessage(result.ok ? "\u9879\u76EE\u5DF2\u5F7B\u5E95\u5220\u9664" : result.error?.message || "\u5220\u9664\u5931\u8D25");
      if (result.ok) await loadFirst(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const archiveRow = async (project) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.wmb.updateStudioProject({ projectId: project.id, expectedRevision: project.revision, archived: !project.archivedAt });
      setMessage(result.ok ? project.archivedAt ? "\u5DF2\u6062\u590D\u9879\u76EE" : "\u5DF2\u5F52\u6863\u9879\u76EE\uFF0C\u53EF\u5728\u300C\u5DF2\u5F52\u6863\u300D\u4E2D\u6062\u590D" : result.error?.message || "\u64CD\u4F5C\u5931\u8D25");
      if (result.ok) await loadFirst(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!selected || busy || readOnlyVersion) return;
    if (!editorBody.trim() || !activePlatform && !editorTitle.trim()) {
      setMessage(!editorBody.trim() ? "\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A" : "\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
      return;
    }
    if (!dirty) {
      setMessage("\u5185\u5BB9\u6CA1\u6709\u6539\u52A8");
      window.setTimeout(() => setMessage((current) => current === "\u5185\u5BB9\u6CA1\u6709\u6539\u52A8" ? "" : current), 1600);
      return;
    }
    setBusy(true);
    setMessage("\u6B63\u5728\u4FDD\u5B58\u2026");
    const platformNewVersion = Boolean(activePlatform && !activePlatformVersion);
    if (annotationScope && rowsScopeKeyRef.current === annotationScopeKeyValue && !platformNewVersion) {
      const annotationsSynced = await syncAnnotationsToBody(annotationScope, annotationScopeKeyValue, editorBody, "incremental");
      if (!annotationsSynced) {
        setMessage("\u6279\u6CE8\u540C\u6B65\u5931\u8D25\uFF0C\u6B63\u6587\u5C1A\u672A\u4FDD\u5B58\uFF0C\u8BF7\u91CD\u8BD5");
        setBusy(false);
        return;
      }
    }
    window.clearTimeout(reconcileTimer.current);
    try {
      if (activePlatform) {
        if (!latest) {
          setMessage("\u8BF7\u5148\u4FDD\u5B58\u6838\u5FC3\u6B63\u6587\uFF0C\u518D\u521B\u5EFA\u5E73\u53F0\u7248\u672C");
          return;
        }
        const result2 = await window.wmb.saveStudioPlatform({
          projectId: selected.id,
          contentVersionId: activePlatformVersion?.contentVersionId ?? latest.id,
          platform: activePlatform,
          format: activePlatformVersion?.format ?? "text",
          title: editorTitle.trim() || void 0,
          body: editorBody,
          assetIds: activePlatformDraft?.assetIds ?? activePlatformVersion?.assets ?? [],
          expectedRevision: activePlatformVersion?.revision,
          versionId: activePlatformVersion?.id
        });
        if (!result2.ok || !result2.data) {
          setMessage(result2.error?.code === "REVISION_CONFLICT" ? "\u5E73\u53F0\u7248\u672C\u5DF2\u5728\u5176\u4ED6\u4F4D\u7F6E\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u9879\u76EE\u540E\u518D\u4FDD\u5B58" : result2.error?.message || "\u4FDD\u5B58\u5931\u8D25");
          return;
        }
        const savedId = result2.data.id;
        setPlatformSelections((current) => ({ ...current, [activePlatform]: savedId }));
        if (activePlatformDraftKey) setPlatformDrafts((current) => {
          const next = { ...current };
          delete next[activePlatformDraftKey];
          return next;
        });
        const detail = await window.wmb.getStudioProject(selected.id);
        if (detail) setSelected(detail);
        await loadFirst(true);
        setAnnotationReloadTick((tick) => tick + 1);
        setMessage(`\u5DF2\u4FDD\u5B58${platformNames[activePlatform]}\u5E73\u53F0\u7248\u672C \xB7 \u7248\u672C ${result2.data.revision}`);
        return;
      }
      const result = await window.wmb.saveStudioCore({ projectId: selected.id, title: editorTitle.trim(), body: editorBody, expectedRevision: selected.revision });
      setMessage(result.ok ? "\u5DF2\u4FDD\u5B58" : result.error?.code === "REVISION_CONFLICT" ? "\u5185\u5BB9\u5DF2\u5728\u5176\u4ED6\u4F4D\u7F6E\u66F4\u65B0\uFF0C\u8BF7\u8BFB\u53D6\u6700\u65B0\u5185\u5BB9\u540E\u518D\u4FDD\u5B58" : result.error?.message || "\u4FDD\u5B58\u5931\u8D25");
      if (result.ok) {
        await reload();
        setAnnotationReloadTick((tick) => tick + 1);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const writeDraft = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setMessage("Pi \u6B63\u5728\u5199\u521D\u7A3F\u2026");
    try {
      const result = await window.wmb.startStudioDraft({ businessDate: planDate, projectId: selected.id });
      setMessage(result.ok ? result.data?.task.status === "needs_user" ? result.data.task.errorMessage || "\u9700\u8981\u7528\u6237\u5904\u7406" : "Pi \u521D\u7A3F\u4EFB\u52A1\u5DF2\u5B8C\u6210" : result.error?.message || "\u521D\u7A3F\u5931\u8D25");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const update = async (change) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await window.wmb.updateStudioProject({ projectId: selected.id, expectedRevision: selected.revision, ...change });
      if (result.ok) {
        setSelected(result.data);
        setMessage(change.archived === true ? "\u5DF2\u5F52\u6863" : change.archived === false ? "\u5DF2\u6062\u590D" : change.topicId !== void 0 ? "\u957F\u671F\u4E3B\u9898\u5DF2\u66F4\u65B0" : "\u5DE5\u4F5C\u72B6\u6001\u5DF2\u66F4\u65B0");
        await loadFirst();
      } else {
        setMessage(result.error?.code === "REVISION_CONFLICT" ? "\u9879\u76EE\u5DF2\u5728\u5176\u4ED6\u4F4D\u7F6E\u66F4\u65B0\uFF0C\u5DF2\u8BFB\u53D6\u6700\u65B0\u72B6\u6001" : result.error?.message || "\u9879\u76EE\u66F4\u65B0\u5931\u8D25");
        setSelected(result.error?.details?.current ?? null);
        if (!result.error?.details?.current) await reload();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const saveFromVersion = async () => {
    if (!selected || !viewedVersion || busy) return;
    setBusy(true);
    setMessage(`\u6B63\u5728\u57FA\u4E8E v${viewedVersion.number} \u53E6\u5B58\u2026`);
    try {
      const result = await window.wmb.saveStudioCore({
        projectId: selected.id,
        title: selected.title,
        body: viewedVersion.body,
        expectedRevision: selected.revision
      });
      if (!result.ok) setMessage(result.error?.code === "REVISION_CONFLICT" ? "\u9879\u76EE\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u8BFB\u53D6\u6700\u65B0\u7248\u540E\u91CD\u8BD5" : result.error?.message || "\u53E6\u5B58\u5931\u8D25");
      else {
        setMessage(`\u5DF2\u57FA\u4E8E v${viewedVersion.number} \u65B0\u589E\u4E00\u4E2A\u7248\u672C`);
        await reload();
        setViewedVersionId(null);
        setAnnotationReloadTick((tick) => tick + 1);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const copyVersion = async () => {
    if (!selected || !viewedVersion || busy) return;
    setBusy(true);
    setMessage(`\u6B63\u5728\u590D\u5236 v${viewedVersion.number}\u2026`);
    try {
      const result = await window.wmb.copyStudioVersionToProject({
        sourceProjectId: selected.id,
        contentVersionId: viewedVersion.id,
        title: copyTitle
      });
      if (!result.ok || !result.data) setMessage(result.error?.message || "\u590D\u5236\u5931\u8D25");
      else {
        setProjects((current) => [result.data, ...current.filter((item) => item.id !== result.data.id)]);
        onSelect(result.data.id);
        setMessage(`\u5DF2\u521B\u5EFA\u72EC\u7ACB\u9879\u76EE\uFF1A${result.data.title}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const reloadAnnotations = () => setAnnotationReloadTick((tick) => tick + 1);
  const readCurrentSelection = () => {
    if (!annotationsEditable) return null;
    if (editorMode === "source") {
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
  const createAnnotationAt = async (snapshot, note) => {
    if (!selected || !annotationScope || annotationBusy || readOnlyVersion) return;
    const validation = validateAnnotationSelection(snapshot.basis, snapshot.start, snapshot.end, openAnnotationRows);
    if (!validation.ok) {
      setMessage(validation.reason === "overlap" ? "\u6240\u9009\u6587\u5B57\u5DF2\u6709\u95EE\u9898\u6807\u8BB0\uFF0C\u8BF7\u5148\u7F16\u8F91\u6216\u79FB\u9664\u539F\u6807\u8BB0" : validation.reason === "heading" ? "\u6807\u9898\u4E0D\u80FD\u6DFB\u52A0\u95EE\u9898\u6807\u8BB0" : "\u8BF7\u62D6\u9009\u975E\u7A7A\u767D\u6B63\u6587\u6587\u5B57\u540E\u518D\u6807\u8BB0");
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
        window.clearTimeout(reconcileTimer.current);
        backendBodyRef.current = editorBody;
        setContextPanelTab("annotations");
        setSelectedAnnotationId(result.data.id);
        setMessage("\u5DF2\u6DFB\u52A0\u95EE\u9898\u6807\u8BB0");
      } else {
        setMessage(result.error?.message || "\u521B\u5EFA\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnnotationBusy(false);
    }
  };
  const updateAnnotationNote = async (annotationId, note) => {
    const row = annotationRows.find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.updateStudioAnnotation({ id: annotationId, expectedRevision: row.revision, note: note?.trim() ? note.trim() : null });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => item.id === result.data.id ? result.data : item));
        setMessage("\u6279\u6CE8\u8BF4\u660E\u5DF2\u66F4\u65B0");
      } else if (result.error?.code === "REVISION_CONFLICT") {
        setMessage("\u6279\u6CE8\u5DF2\u5728\u5176\u4ED6\u4F4D\u7F6E\u66F4\u65B0\uFF0C\u5DF2\u91CD\u65B0\u8BFB\u53D6");
        reloadAnnotations();
      } else {
        setMessage(result.error?.message || "\u66F4\u65B0\u5931\u8D25");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnnotationBusy(false);
    }
  };
  const removeAnnotation = async (annotationId) => {
    const row = annotationRows.find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.resolveStudioAnnotation({ id: annotationId, expectedRevision: row.revision, reason: "user_removed" });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => item.id === result.data.id ? result.data : item));
        setMessage("\u5DF2\u79FB\u9664\u6807\u8BB0");
      } else if (result.error?.code === "REVISION_CONFLICT") {
        setMessage("\u6279\u6CE8\u5DF2\u5728\u5176\u4ED6\u4F4D\u7F6E\u66F4\u65B0\uFF0C\u5DF2\u91CD\u65B0\u8BFB\u53D6");
        reloadAnnotations();
      } else {
        setMessage(result.error?.message || "\u79FB\u9664\u5931\u8D25");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnnotationBusy(false);
    }
  };
  const reopenAnnotation = async (annotationId) => {
    const row = annotationRows.find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await window.wmb.reopenStudioAnnotation({ id: annotationId, expectedRevision: row.revision, body: editorBody });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => item.id === result.data.id ? result.data : item));
        setMessage("\u6279\u6CE8\u5DF2\u91CD\u65B0\u6253\u5F00");
      } else {
        setMessage(result.error?.message || "\u65E0\u6CD5\u91CD\u65B0\u6253\u5F00\uFF1A\u539F\u6587\u672A\u5728\u5F53\u524D\u6B63\u6587\u4E2D\u552F\u4E00\u5B9A\u4F4D\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u6587\u5B57\u521B\u5EFA\u6807\u8BB0");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnnotationBusy(false);
    }
  };
  const selectAnnotationFromBody = (annotationId) => {
    setSelectedAnnotationId(annotationId);
    setContextPanelTab("annotations");
  };
  const locateAnnotation = (annotationId) => {
    setSelectedAnnotationId(annotationId);
    setFlashAnnotationId(annotationId);
    window.setTimeout(() => setFlashAnnotationId((current) => current === annotationId ? null : current), 1400);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const marker = document.querySelector(`[data-studio-annotation-id="${annotationId}"]`);
      if (marker) {
        marker.scrollIntoView({ block: "center", behavior });
        return;
      }
      const mirror = document.querySelector(`[data-annotation-mirror-id="${annotationId}"]`);
      mirror?.scrollIntoView({ block: "center", behavior });
    }));
  };
  const markSelection = async () => {
    const snapshot = readCurrentSelection();
    if (!snapshot) {
      setMessage("\u8BF7\u5148\u62D6\u9009\u8981\u6807\u8BB0\u7684\u6587\u5B57");
      return;
    }
    await createAnnotationAt(snapshot, null);
  };
  const openAnnotationMenu = (annotationId, x, y) => {
    setAnnotationMenu({ x, y, kind: "edit", annotationId });
  };
  const handleEditorContextMenu = (event) => {
    if (!annotationsEditable || !annotationScope) return;
    const markerId = event.target.closest("[data-studio-annotation-id]")?.getAttribute("data-studio-annotation-id");
    if (markerId) {
      event.preventDefault();
      setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: "edit", annotationId: markerId });
      return;
    }
    if (editorMode === "source") {
      const hit = sourceHitTestRef.current?.(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: "edit", annotationId: hit });
        return;
      }
    }
    const snapshot = readCurrentSelection();
    if (!snapshot) return;
    const validation = validateAnnotationSelection(snapshot.basis, snapshot.start, snapshot.end, openAnnotationRows);
    if (!validation.ok) {
      if (validation.reason === "overlap") {
        event.preventDefault();
        setMessage("\u6240\u9009\u6587\u5B57\u5DF2\u6709\u95EE\u9898\u6807\u8BB0\uFF0C\u8BF7\u5148\u7F16\u8F91\u6216\u79FB\u9664\u539F\u6807\u8BB0");
      }
      return;
    }
    event.preventDefault();
    setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: "create", snapshot });
  };
  const confirmNoteInput = async (note) => {
    const input2 = noteInput;
    if (!input2) return;
    if (input2.mode === "create") await createAnnotationAt(input2.snapshot, note);
    else await updateAnnotationNote(input2.annotationId, note);
    setNoteInput(null);
  };
  const discussAnnotationsWithPi = () => {
    if (!openAnnotationRows.length) return;
    window.dispatchEvent(new CustomEvent("studio-discuss-pi", { detail: { projectId: selected?.id, annotationCount: openAnnotationRows.length } }));
  };
  const annotationMenuItems = useMemo(() => {
    if (!annotationMenu) return [];
    if (annotationMenu.kind === "create") {
      return [
        { id: "mark", label: "\u6807\u8BB0\u4E3A\u6709\u95EE\u9898", onSelect: () => {
          void createAnnotationAt(annotationMenu.snapshot, null);
        } },
        { id: "mark-note", label: "\u6807\u8BB0\u5E76\u8BF4\u660E\u2026", onSelect: () => setNoteInput({ x: annotationMenu.x + 10, y: annotationMenu.y + 10, mode: "create", snapshot: annotationMenu.snapshot }) }
      ];
    }
    const row = annotationRows.find((item) => item.id === annotationMenu.annotationId);
    return [
      { id: "edit-note", label: row?.note ? "\u7F16\u8F91\u8BF4\u660E\u2026" : "\u6DFB\u52A0\u8BF4\u660E\u2026", onSelect: () => setNoteInput({ x: annotationMenu.x + 10, y: annotationMenu.y + 10, mode: "edit", annotationId: annotationMenu.annotationId, initial: row?.note ?? "" }) },
      { id: "remove", label: "\u79FB\u9664\u6807\u8BB0", onSelect: () => {
        void removeAnnotation(annotationMenu.annotationId);
      } }
    ];
  }, [annotationMenu, annotationRows]);
  const jumpToStart = () => {
    const canvas = canvasRef.current;
    if (canvas) canvas.scrollTo({ top: 0, behavior: "smooth" });
  };
  const jumpToHeading = (item) => {
    const run = () => {
      const canvas = canvasRef.current;
      const title2 = item.title.trim();
      const roots = [
        bodyInput.current,
        canvas?.querySelector(".studio-live-false-body")
      ].filter(Boolean);
      for (const root of roots) {
        const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")];
        const hit = headings.find((node) => (node.textContent || "").trim() === title2) ?? headings.find((node) => (node.textContent || "").trim().includes(title2));
        if (hit) {
          hit.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      }
      const ta = sourceInput.current;
      if (ta && canvas) {
        const lines = bodyWithoutLeadingTitle(editorBody).split("\n");
        const ratio = lines.length ? Math.min(1, Math.max(0, item.index / lines.length)) : 0;
        const top = Math.max(0, (ta.scrollHeight - ta.clientHeight) * ratio);
        ta.focus();
        ta.scrollTop = top;
        canvas.scrollTo({ top: Math.max(0, ta.offsetTop - 24), behavior: "smooth" });
        const lineStart = lines.slice(0, item.index).join("\n").length + (item.index > 0 ? 1 : 0);
        const lineText = lines[item.index] ?? "";
        try {
          ta.setSelectionRange(lineStart, lineStart + lineText.length);
        } catch {
        }
      }
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(run));
  };
  if (!selectedId) {
    return /* @__PURE__ */ jsxs("section", { className: "studio-library", children: [
      /* @__PURE__ */ jsx("input", { ref: importInput, className: "studio-import-input", type: "file", accept: ".md,.markdown,.txt,text/plain,text/markdown", onChange: (event) => {
        const file = event.target.files?.[0];
        if (file) void importProject(file);
      } }),
      /* @__PURE__ */ jsx("input", { ref: imageInput, className: "studio-import-input", type: "file", accept: "image/*", onChange: (event) => {
        const file = event.target.files?.[0];
        if (file) void insertImageFile(file);
      } }),
      /* @__PURE__ */ jsx(StudioLibraryHeader, { summary: statusSummary, projects, hasMore, status, archived, setStatus, setArchived, creating, onCreate: () => setCreating(true) }),
      /* @__PURE__ */ jsxs("div", { className: "studio-library-body", children: [
        creating && /* @__PURE__ */ jsxs("div", { className: "studio-create-row", children: [
          /* @__PURE__ */ jsx("input", { autoFocus: true, value: newTitle, onChange: (event) => setNewTitle(event.target.value), onKeyDown: (event) => {
            if (event.key === "Enter") void createProject();
          }, placeholder: "\u8F93\u5165\u65B0\u9879\u76EE\u6807\u9898" }),
          /* @__PURE__ */ jsx("button", { className: "primary-button", disabled: !newTitle.trim() || busy, onClick: () => void createProject(), children: "\u521B\u5EFA\u5E76\u5F00\u59CB\u5199\u4F5C" }),
          /* @__PURE__ */ jsx("button", { className: "secondary-button", onClick: () => {
            setCreating(false);
            setNewTitle("");
          }, children: "\u53D6\u6D88" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "studio-library-tools", children: [
          /* @__PURE__ */ jsxs("label", { className: "studio-search-wrap", children: [
            "\u2315 ",
            /* @__PURE__ */ jsx("input", { className: "studio-search", type: "search", value: queryDraft, onChange: (event) => setQueryDraft(event.target.value), placeholder: "\u641C\u7D22\u9879\u76EE\u6807\u9898\u6216\u6B63\u6587", "aria-label": "\u641C\u7D22\u5185\u5BB9\u9879\u76EE" })
          ] }),
          /* @__PURE__ */ jsxs("select", { "aria-label": "\u9879\u76EE\u6392\u5E8F", value: order, onChange: (event) => setOrder(event.target.value), children: [
            /* @__PURE__ */ jsx("option", { value: "recent", children: "\u6700\u8FD1\u66F4\u65B0" }),
            /* @__PURE__ */ jsx("option", { value: "oldest", children: "\u6700\u65E9\u66F4\u65B0" }),
            /* @__PURE__ */ jsx("option", { value: "versions", children: "\u7248\u672C\u6700\u591A" })
          ] }),
          /* @__PURE__ */ jsxs("select", { "aria-label": "\u5E73\u53F0\u7B5B\u9009", value: platform ?? "all", onChange: (event) => setPlatform(event.target.value === "all" ? void 0 : event.target.value), children: [
            /* @__PURE__ */ jsx("option", { value: "all", children: "\u5168\u90E8\u5E73\u53F0" }),
            enabledPlatforms.map((value) => /* @__PURE__ */ jsx("option", { value, children: platformNames[value] }, value))
          ] }),
          /* @__PURE__ */ jsxs("span", { children: [
            "\u627E\u5230 ",
            projects.length,
            hasMore || offset ? "+" : "",
            " \u4E2A\u9879\u76EE"
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "studio-project-table", role: "table", children: [
          /* @__PURE__ */ jsxs("div", { className: "studio-project-row head", role: "row", children: [
            /* @__PURE__ */ jsx("span", { children: "\u9879\u76EE" }),
            /* @__PURE__ */ jsx("span", { children: "\u5DE5\u4F5C\u72B6\u6001" }),
            /* @__PURE__ */ jsx("span", { children: "\u5E73\u53F0\u5185\u5BB9" }),
            /* @__PURE__ */ jsx("span", { children: "\u6700\u8FD1\u66F4\u65B0" }),
            /* @__PURE__ */ jsx("span", { children: "\u7248\u672C" }),
            /* @__PURE__ */ jsx("span", {})
          ] }),
          projects.map((project) => /* @__PURE__ */ jsxs(
            "div",
            {
              className: `studio-project-row${listFocusId === project.id ? " selected" : ""}`,
              role: "row",
              tabIndex: 0,
              title: listFocusId === project.id ? "\u518D\u6B21\u70B9\u51FB\u53D6\u6D88 Pi \u7126\u70B9\uFF1B\u53CC\u51FB\u6216\u70B9\u300C\u6253\u5F00\u300D\u8FDB\u5165\u7F16\u8F91" : "\u5355\u51FB\u8BBE\u4E3A Pi \u7126\u70B9\uFF1B\u53CC\u51FB\u6216\u70B9\u300C\u6253\u5F00\u300D\u8FDB\u5165\u7F16\u8F91",
              onClick: () => setListFocusId((current) => current === project.id ? null : project.id),
              onDoubleClick: () => onSelect(project.id),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  onSelect(project.id);
                }
                if (event.key === " ") {
                  event.preventDefault();
                  setListFocusId((current) => current === project.id ? null : project.id);
                }
              },
              children: [
                /* @__PURE__ */ jsxs("span", { className: "studio-project-title-cell", children: [
                  /* @__PURE__ */ jsxs("span", { className: "studio-project-title-line", children: [
                    (() => {
                      const g = priorityGrade(project.planItemPriority);
                      const n = Number(project.planItemPriority);
                      return Number.isFinite(n) ? /* @__PURE__ */ jsx("strong", { className: "opp-grade", "data-grade": g, children: g }) : null;
                    })(),
                    /* @__PURE__ */ jsx("button", { type: "button", className: "studio-project-name", onClick: (event) => {
                      event.stopPropagation();
                      onSelect(project.id);
                    }, children: project.title })
                  ] }),
                  /* @__PURE__ */ jsxs("small", { children: [
                    "\u9879\u76EE ",
                    project.id.slice(0, 8),
                    " \xB7 \u6700\u65B0\u6B63\u6587\u6309\u9700\u8BFB\u53D6"
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("span", { className: "studio-project-state", children: [
                  /* @__PURE__ */ jsx("i", { "data-status": project.status }),
                  project.archivedAt ? "\u5DF2\u5F52\u6863" : statuses.find((item) => item.value === project.status)?.label
                ] }),
                /* @__PURE__ */ jsxs("span", { className: "studio-project-platform", children: [
                  enabledPlatforms.filter((value) => project.platforms[value] > 0).length,
                  " / ",
                  enabledPlatforms.length,
                  /* @__PURE__ */ jsx("i", { children: /* @__PURE__ */ jsx("b", { style: { width: `${enabledPlatforms.filter((value) => project.platforms[value] > 0).length / Math.max(1, enabledPlatforms.length) * 100}%` } }) })
                ] }),
                /* @__PURE__ */ jsx("time", { children: formatTime(project.updatedAt) }),
                /* @__PURE__ */ jsxs("span", { children: [
                  project.versionCount,
                  " \u4E2A\u7248\u672C"
                ] }),
                /* @__PURE__ */ jsxs("span", { className: "studio-row-actions", children: [
                  /* @__PURE__ */ jsx("button", { className: "studio-row-action", "aria-label": `\u6253\u5F00\u9879\u76EE ${project.title}`, onClick: (event) => {
                    event.stopPropagation();
                    onSelect(project.id);
                  }, children: "\u6253\u5F00" }),
                  /* @__PURE__ */ jsx("button", { className: "studio-row-action", "aria-label": `${project.archivedAt ? "\u6062\u590D" : "\u5F52\u6863"}\u9879\u76EE ${project.title}`, onClick: (event) => {
                    event.stopPropagation();
                    void archiveRow(project);
                  }, children: project.archivedAt ? "\u6062\u590D" : "\u5F52\u6863" }),
                  Object.values(project.platforms).every((count) => !count) && /* @__PURE__ */ jsx("button", { className: "studio-row-action danger", "aria-label": `\u5220\u9664\u9879\u76EE ${project.title}`, onClick: (event) => {
                    event.stopPropagation();
                    void deleteRow(project);
                  }, children: "\u5220\u9664" })
                ] })
              ]
            },
            project.id
          ))
        ] }),
        loading && !projects.length && /* @__PURE__ */ jsx("p", { className: "studio-loading", children: "\u6B63\u5728\u8BFB\u53D6\u9879\u76EE\u2026" }),
        !loading && !projects.length && /* @__PURE__ */ jsxs("div", { className: "compact-empty", children: [
          /* @__PURE__ */ jsx("h2", { children: "\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u9879\u76EE" }),
          /* @__PURE__ */ jsx("p", { children: "\u8C03\u6574\u641C\u7D22\u6216\u72B6\u6001\u6761\u4EF6\u540E\u91CD\u8BD5\u3002" })
        ] }),
        /* @__PURE__ */ jsxs("footer", { className: "studio-library-pagination", children: [
          /* @__PURE__ */ jsxs("span", { children: [
            "\u7B2C ",
            projects.length ? offset + 1 : 0,
            "\u2013",
            offset + projects.length,
            " \u9879\uFF0C\u6BCF\u9875\u6700\u591A 50 \u9879"
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("button", { className: "secondary-button", disabled: offset === 0, onClick: () => setOffset(Math.max(0, offset - 50)), children: "\u4E0A\u4E00\u9875" }),
            /* @__PURE__ */ jsx("button", { className: "secondary-button", disabled: !hasMore, onClick: () => setOffset(offset + 50), children: "\u4E0B\u4E00\u9875" })
          ] })
        ] })
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxs("section", { className: `studio-editor-view${contextOpen ? " context-open" : ""}`, children: [
    /* @__PURE__ */ jsx("input", { ref: imageInput, className: "studio-import-input", type: "file", accept: "image/*", onChange: (event) => {
      const file = event.target.files?.[0];
      if (file) void insertImageFile(file);
    } }),
    /* @__PURE__ */ jsx("input", { ref: replaceImageInput, className: "studio-import-input", type: "file", accept: "image/*", onChange: (event) => {
      const file = event.target.files?.[0];
      if (file) void replaceAssetImage(file);
    } }),
    /* @__PURE__ */ jsx(StudioEditorTop, { selected, dirty, latestCreatedAt: activePlatformVersion?.updatedAt ?? latest?.createdAt, documentLabel: activePlatform ? `${platformNames[activePlatform]} \xB7 ${activePlatformVersion ? `\u7248\u672C ${activePlatformVersion.revision}` : "\u65B0\u7248\u672C"}` : void 0, onBack: () => onSelect(null), toggleContext: () => setContextOpen((value) => !value), viewedVersion: Boolean(readOnlyVersion), editorMode, setEditorMode, busy, save }),
    /* @__PURE__ */ jsxs("div", { className: "studio-editor-grid", children: [
      /* @__PURE__ */ jsx(StudioOutline, { outline, tab, setTab, platformVersions: selected?.platformVersions ?? {}, onJumpToStart: jumpToStart, onJumpToHeading: jumpToHeading }),
      /* @__PURE__ */ jsx("main", { className: "studio-document", children: selected ? /* @__PURE__ */ jsxs(Fragment, { children: [
        editorTab && /* @__PURE__ */ jsxs(Fragment, { children: [
          readOnlyVersion && /* @__PURE__ */ jsxs("section", { className: "historical-version-notice", children: [
            /* @__PURE__ */ jsxs("span", { children: [
              "\u6B63\u5728\u67E5\u770B\u4E0D\u53EF\u4FEE\u6539\u7684\u7248\u672C v",
              readOnlyVersion.number
            ] }),
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("button", { className: "secondary-button", onClick: () => setViewedVersionId(null), children: "\u8FD4\u56DE\u6700\u65B0\u7248" }),
              /* @__PURE__ */ jsx("button", { className: "secondary-button", disabled: busy, onClick: () => void saveFromVersion(), children: "\u57FA\u4E8E\u6B64\u7248\u672C\u53E6\u5B58" })
            ] }),
            /* @__PURE__ */ jsxs("label", { children: [
              "\u65B0\u9879\u76EE\u6807\u9898",
              /* @__PURE__ */ jsx("input", { value: copyTitle, onChange: (event) => setCopyTitle(event.target.value) })
            ] }),
            /* @__PURE__ */ jsx("button", { className: "primary-button", disabled: busy || !copyTitle.trim(), onClick: () => void copyVersion(), children: "\u590D\u5236\u7248\u672C\u4E3A\u65B0\u9879\u76EE" })
          ] }),
          !readOnlyVersion && /* @__PURE__ */ jsx(StudioFormatBar, { busy, execRich, formatSelection, insertMarkdown, insertImageFile, toggleFind: () => setFindOpen((value) => !value), onMarkSelection: () => {
            void markSelection();
          }, canMark: annotationsEditable }),
          findOpen && !readOnlyVersion && /* @__PURE__ */ jsxs("div", { className: "studio-findbar", children: [
            /* @__PURE__ */ jsx("input", { value: findText, onChange: (event) => setFindText(event.target.value), placeholder: "\u67E5\u627E\u6B63\u6587" }),
            /* @__PURE__ */ jsx("input", { id: "studio-replace", placeholder: "\u66FF\u6362\u4E3A" }),
            /* @__PURE__ */ jsxs("span", { children: [
              findText ? editorBody.split(findText).length - 1 : 0,
              " \u5904\u5339\u914D"
            ] }),
            /* @__PURE__ */ jsx("button", { disabled: !findText || !editorBody.includes(findText), onClick: () => {
              const replacement = document.querySelector("#studio-replace")?.value ?? "";
              changeBody(editorBody.split(findText).join(replacement));
            }, children: "\u5168\u90E8\u66FF\u6362" }),
            /* @__PURE__ */ jsx("button", { onClick: () => setFindOpen(false), children: "\u5173\u95ED" })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "studio-canvas", ref: canvasRef, children: /* @__PURE__ */ jsxs("article", { className: "studio-paper", children: [
            /* @__PURE__ */ jsx("textarea", { id: "studio-title", className: "studio-title-input", value: editorTitle, rows: 1, disabled: busy || Boolean(readOnlyVersion), placeholder: activePlatform ? "\u8F93\u5165\u5E73\u53F0\u6807\u9898\uFF08\u53EF\u9009\uFF09" : void 0, onChange: (event) => changeEditorTitle(event.target.value), onInput: (event) => {
              const el = event.currentTarget;
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }, ref: (node) => {
              if (!node) return;
              node.style.height = "auto";
              node.style.height = `${node.scrollHeight}px`;
            } }),
            /* @__PURE__ */ jsxs("div", { className: "studio-doc-meta", children: [
              /* @__PURE__ */ jsx("span", { children: activePlatform ? `${platformNames[activePlatform]} \xB7 ${activePlatformVersion?.format ?? "text"}` : "\u6838\u5FC3\u6B63\u6587" }),
              /* @__PURE__ */ jsx("span", { children: activePlatform ? activePlatformVersion ? `\u7248\u672C ${activePlatformVersion.revision}` : "\u9996\u7248\u672A\u4FDD\u5B58" : statuses.find((item) => item.value === selected.status)?.label }),
              /* @__PURE__ */ jsxs("span", { children: [
                selected.sources.length,
                " \u6761\u6765\u6E90"
              ] }),
              selected.creativeBrief && /* @__PURE__ */ jsx("span", { children: "\u6765\u81EA\u521B\u4F5C\u7B80\u62A5" }),
              /* @__PURE__ */ jsxs("span", { children: [
                activePlatform ? activePlatformDraft?.assetIds.length ?? activePlatformVersion?.assets.length ?? 0 : selected.assets.length,
                " \u4E2A\u7D20\u6750"
              ] }),
              /* @__PURE__ */ jsx("span", { children: editorMode === "source" ? "Markdown \u6E90\u7801" : "\u5BCC\u6587\u672C" })
            ] }),
            readOnlyVersion || editorMode === "rich" ? /* @__PURE__ */ jsxs("div", { className: "studio-rich-annotate-wrap", ref: richWrapRef, children: [
              /* @__PURE__ */ jsx(
                "div",
                {
                  ref: (node) => {
                    bodyInput.current = node;
                    if (node && (readOnlyVersion || editorMode === "rich")) {
                      const html = renderMarkdown(bodyWithoutLeadingTitle(displayBody));
                      if (node.innerHTML !== html) node.innerHTML = html;
                    }
                  },
                  id: "studio-body",
                  className: "studio-rich-editor",
                  contentEditable: !readOnlyVersion && !busy && editorMode === "rich",
                  suppressContentEditableWarning: true,
                  onInput: (event) => changeBody(htmlToMarkdown(event.currentTarget)),
                  onPaste: handleEditorPaste,
                  onContextMenu: handleEditorContextMenu,
                  onClick: handleInlineFigureClick,
                  onBlur: (event) => {
                    if (readOnlyVersion || editorMode !== "rich") return;
                    event.currentTarget.innerHTML = renderMarkdown(bodyWithoutLeadingTitle(editorBody));
                    applyInlineLayout(event.currentTarget);
                  }
                }
              ),
              !readOnlyVersion && /* @__PURE__ */ jsx(StudioAnnotationOverlay, { mode: "rich", editorRef: bodyInput, wrapRef: richWrapRef, body: editorBody, leadingTitleLen: annotationLeadingTitleLen, rows: visibleOpenAnnotations, selectedAnnotationId, flashAnnotationId, onSelectAnnotation: selectAnnotationFromBody, onAnnotationMenu: openAnnotationMenu })
            ] }) : /* @__PURE__ */ jsxs("div", { className: "studio-source-stack", children: [
              /* @__PURE__ */ jsxs("div", { className: "studio-source-annotate-wrap", ref: sourceWrapRef, children: [
                /* @__PURE__ */ jsx(
                  "textarea",
                  {
                    ref: sourceInput,
                    id: "studio-body-source",
                    className: "studio-source-editor",
                    value: editorBody,
                    disabled: busy,
                    spellCheck: false,
                    placeholder: activePlatform ? `\u5728\u8FD9\u91CC\u5199\u5B8C\u6574${platformNames[activePlatform]}\u7248\u672C\u3002` : "\u5728\u8FD9\u91CC\u5199\u5B8C\u6574 Markdown\u3002\n\n## \u4E8C\u7EA7\u6807\u9898\n\n\u6B63\u6587\u6BB5\u843D\u3002",
                    onChange: (event) => {
                      changeBody(event.target.value);
                      const textarea = event.currentTarget;
                      textarea.style.height = "auto";
                      const minHeight = Math.max(window.innerHeight - 360, 420);
                      textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
                    },
                    onPaste: handleSourcePaste,
                    onContextMenu: handleEditorContextMenu
                  }
                ),
                /* @__PURE__ */ jsx(StudioAnnotationOverlay, { mode: "source", editorRef: bodyInput, wrapRef: sourceWrapRef, body: editorBody, leadingTitleLen: annotationLeadingTitleLen, rows: visibleOpenAnnotations, selectedAnnotationId, flashAnnotationId, hitTestRef: sourceHitTestRef, onSelectAnnotation: selectAnnotationFromBody, onAnnotationMenu: openAnnotationMenu })
              ] }),
              /* @__PURE__ */ jsxs("section", { className: "studio-live-false", "aria-label": "Markdown \u5B9E\u65F6\u9884\u89C8", children: [
                /* @__PURE__ */ jsx("div", { className: "studio-live-false-label", children: "\u5B9E\u65F6\u9884\u89C8" }),
                /* @__PURE__ */ jsx(
                  "div",
                  {
                    className: "studio-rich-editor studio-live-false-body",
                    onClick: handleInlineFigureClick,
                    dangerouslySetInnerHTML: { __html: renderMarkdown(bodyWithoutLeadingTitle(editorBody)) || '<p class="studio-live-false-empty">\u8F93\u5165 Markdown \u540E\u8FD9\u91CC\u4F1A\u5B9E\u65F6\u6E32\u67D3</p>' }
                  }
                )
              ] })
            ] })
          ] }) }),
          /* @__PURE__ */ jsxs("div", { className: "studio-writing-status", "data-running": busy ? "true" : "false", children: [
            /* @__PURE__ */ jsxs("div", { className: "studio-status-left", children: [
              /* @__PURE__ */ jsxs("span", { className: "studio-status-metrics", children: [
                "\u5B57\u6570 ",
                characterCount,
                " \xB7 \u7EA6 ",
                Math.max(1, Math.ceil(characterCount / 500)),
                " \u5206\u949F"
              ] }),
              /* @__PURE__ */ jsx("span", { className: "studio-status-sep", "aria-hidden": "true", children: "\xB7" }),
              /* @__PURE__ */ jsxs("div", { className: "studio-status-links", "aria-label": "\u5173\u8054\u6765\u6E90\u4E0E\u7D20\u6750", children: [
                /* @__PURE__ */ jsxs("button", { type: "button", className: "studio-status-link", title: "\u67E5\u770B\u5168\u90E8\u5173\u8054\u6765\u6E90", onClick: () => setTab("sources"), children: [
                  "\u6765\u6E90 ",
                  selected.sources.length
                ] }),
                selected.sources.slice(0, 3).map((source) => /* @__PURE__ */ jsx("button", { type: "button", className: "studio-status-chip", title: source.title, onClick: () => {
                  if (onOpenSource) onOpenSource(source.id);
                  else if (source.canonicalUrl) void window.wmb.openExternal(source.canonicalUrl);
                  else setTab("sources");
                }, children: source.title.length > 16 ? source.title.slice(0, 16) + "\u2026" : source.title }, source.id)),
                selected.sources.length > 3 ? /* @__PURE__ */ jsxs("span", { className: "studio-status-more", children: [
                  "+",
                  selected.sources.length - 3
                ] }) : null,
                /* @__PURE__ */ jsx("span", { className: "studio-status-sep", "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsxs("button", { type: "button", className: "studio-status-link", title: "\u67E5\u770B\u5173\u8054\u7D20\u6750", onClick: () => setTab("assets"), children: [
                  "\u7D20\u6750 ",
                  selected.assets.length
                ] }),
                selected.assets.slice(0, 2).map((asset) => /* @__PURE__ */ jsx("button", { type: "button", className: "studio-status-chip", title: asset.relativePath, onClick: () => setTab("assets"), children: (asset.relativePath.split(/[/\\]/).pop() || asset.relativePath).slice(0, 14) }, asset.id)),
                /* @__PURE__ */ jsx("span", { className: "studio-status-sep", "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsxs("button", { ref: imageMenuButtonRef, type: "button", className: "studio-status-link", "aria-haspopup": "menu", "aria-expanded": imageMenuOpen, title: assetImageRefs.length ? "\u67E5\u770B\u672C\u6587\u56FE\u7247\uFF1A\u5B9A\u4F4D\u3001\u66FF\u6362\u3001\u7F16\u8F91\u56FE\u6CE8\u3001\u79FB\u51FA" : "\u5F53\u524D\u6B63\u6587\u6CA1\u6709\u56FE\u7247", onClick: () => imageMenuOpen ? closeImageMenu() : openImageMenu(), children: [
                  "\u672C\u6587\u56FE\u7247 ",
                  assetImageRefs.length,
                  " \u5F20"
                ] }),
                imageMenuOpen && imageMenuRect && /* @__PURE__ */ jsx("div", { ref: imageMenuRef, className: "studio-image-menu", "aria-label": "\u672C\u6587\u56FE\u7247", style: { left: imageMenuRect.left, bottom: imageMenuRect.bottom, width: imageMenuRect.width }, children: assetImageRefs.map((ref, index) => {
                  const asset = assetById.get(ref.assetId);
                  const key = `${ref.assetId}:${ref.occurrence}`;
                  const editing = imageMenuEditKey === key;
                  const busyCard = imageMenuBusyIndex === index;
                  const fileName = asset ? asset.relativePath.split(/[/\\]/).pop() || asset.relativePath : ref.assetId;
                  return /* @__PURE__ */ jsxs("div", { className: "studio-image-card", children: [
                    /* @__PURE__ */ jsx("img", { className: "studio-image-thumb", src: `wmb-asset://${ref.assetId}`, alt: "", loading: "lazy" }),
                    /* @__PURE__ */ jsxs("div", { className: "studio-image-card-main", children: [
                      /* @__PURE__ */ jsxs("span", { className: "studio-image-ordinal", children: [
                        "\u56FE ",
                        index + 1
                      ] }),
                      editing ? /* @__PURE__ */ jsx(
                        "input",
                        {
                          className: "studio-image-caption-input",
                          autoFocus: true,
                          value: imageMenuAltDrafts[key] ?? ref.alt,
                          "aria-label": `\u56FE ${index + 1} \u56FE\u6CE8`,
                          onChange: (event) => setImageMenuAltDrafts((current) => ({ ...current, [key]: event.target.value })),
                          onKeyDown: (event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              saveCaptionEdit(ref);
                            }
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              setImageMenuEditKey(null);
                            }
                          }
                        }
                      ) : /* @__PURE__ */ jsx("span", { className: `studio-image-caption${ref.alt ? "" : " empty"}`, children: ref.alt || "\u672A\u586B\u5199\u56FE\u6CE8" }),
                      /* @__PURE__ */ jsxs("span", { className: "studio-image-meta", children: [
                        fileName,
                        asset ? ` \xB7 ${formatAssetSize(asset.byteCount)}` : ""
                      ] })
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "studio-image-actions", children: [
                      /* @__PURE__ */ jsx("button", { type: "button", onClick: () => locateAssetImage(ref), children: "\u5B9A\u4F4D" }),
                      !readOnlyVersion && /* @__PURE__ */ jsxs(Fragment, { children: [
                        /* @__PURE__ */ jsx("button", { type: "button", disabled: busy || busyCard, onClick: () => requestReplaceAssetImage(ref), children: busyCard ? "\u66FF\u6362\u4E2D\u2026" : "\u66FF\u6362" }),
                        /* @__PURE__ */ jsx("button", { type: "button", className: "studio-image-crop-button", disabled: busy || busyCard, onClick: () => openCropAssetImage(ref), children: "\u88C1\u526A" }),
                        editing ? /* @__PURE__ */ jsx("button", { type: "button", className: "primary", onClick: () => saveCaptionEdit(ref), children: "\u4FDD\u5B58\u56FE\u6CE8" }) : /* @__PURE__ */ jsx("button", { type: "button", disabled: busy, onClick: () => startCaptionEdit(ref), children: "\u7F16\u8F91\u56FE\u6CE8" }),
                        /* @__PURE__ */ jsx("button", { type: "button", className: "danger", disabled: busy, onClick: () => removeAssetImage(ref), children: "\u79FB\u51FA" })
                      ] })
                    ] })
                  ] }, `${key}:${ref.start}`);
                }) })
              ] })
            ] }),
            /* @__PURE__ */ jsx("span", { className: message ? "studio-status-message" : void 0, children: message || (readOnlyVersion ? "\u5386\u53F2\u7248\u672C\u53EA\u8BFB" : dirty ? "\u672A\u4FDD\u5B58" : anyDirty ? "\u5176\u4ED6\u9875\u7B7E\u6709\u672A\u4FDD\u5B58\u4FEE\u6539" : "\u5DF2\u4FDD\u5B58") })
          ] })
        ] }),
        tab === "sources" && /* @__PURE__ */ jsx("section", { className: "studio-detail-list", children: selected.sources.length ? selected.sources.map((source) => /* @__PURE__ */ jsxs("article", { children: [
          /* @__PURE__ */ jsx("span", { children: "\u8D44\u6599\u6765\u6E90" }),
          /* @__PURE__ */ jsx("h3", { children: source.title }),
          /* @__PURE__ */ jsx("p", { children: source.summary || "\u6682\u65E0\u6458\u8981" }),
          /* @__PURE__ */ jsx("small", { children: [source.author, source.publishedAt && formatTime(source.publishedAt)].filter(Boolean).join(" \xB7 ") }),
          source.canonicalUrl && /* @__PURE__ */ jsx("button", { className: "secondary-button", onClick: () => void window.wmb.openExternal(source.canonicalUrl), children: "\u6253\u5F00\u539F\u6587 \u2197" })
        ] }, source.id)) : /* @__PURE__ */ jsxs("div", { className: "compact-empty", children: [
          /* @__PURE__ */ jsx("h2", { children: "\u6CA1\u6709\u5173\u8054\u8D44\u6599" }),
          /* @__PURE__ */ jsx("p", { children: "\u8BE5\u9879\u76EE\u5C1A\u672A\u7ED1\u5B9A\u8D44\u6599\u6765\u6E90\u3002" })
        ] }) }),
        tab === "assets" && /* @__PURE__ */ jsx("section", { className: "studio-detail-list", children: selected.assets.length ? selected.assets.map((asset) => /* @__PURE__ */ jsxs("article", { children: [
          /* @__PURE__ */ jsx("span", { children: asset.mimeType }),
          /* @__PURE__ */ jsx("h3", { children: asset.relativePath }),
          /* @__PURE__ */ jsxs("p", { children: [
            "\u7D20\u6750\u6307\u7EB9 ",
            asset.sha256
          ] }),
          /* @__PURE__ */ jsxs("small", { children: [
            asset.byteCount,
            " \u5B57\u8282",
            asset.width && asset.height ? ` \xB7 ${asset.width}\xD7${asset.height}` : "",
            asset.durationMs ? ` \xB7 ${asset.durationMs} \u6BEB\u79D2` : "",
            " \xB7 ",
            asset.origin
          ] })
        ] }, asset.id)) : /* @__PURE__ */ jsxs("div", { className: "compact-empty", children: [
          /* @__PURE__ */ jsx("h2", { children: "\u6CA1\u6709\u5173\u8054\u7D20\u6750" }),
          /* @__PURE__ */ jsx("p", { children: "\u53EA\u6709\u88AB\u5E73\u53F0\u7248\u672C\u771F\u5B9E\u5F15\u7528\u7684\u7D20\u6750\u624D\u4F1A\u663E\u793A\u3002" })
        ] }) })
      ] }) : /* @__PURE__ */ jsxs("section", { className: "empty-state editor-empty", children: [
        /* @__PURE__ */ jsx("h2", { children: message ? "\u9879\u76EE\u8BE6\u60C5\u8BFB\u53D6\u5931\u8D25" : "\u9009\u62E9\u4E00\u4E2A\u5185\u5BB9\u9879\u76EE" }),
        /* @__PURE__ */ jsx("p", { children: message || "\u5DE6\u4FA7\u4F1A\u663E\u793A\u7B26\u5408\u5F53\u524D\u6761\u4EF6\u7684\u9879\u76EE\u3002" }),
        selectedId && message && /* @__PURE__ */ jsx("button", { onClick: () => void loadDetail(selectedId), children: "\u91CD\u65B0\u8BFB\u53D6" })
      ] }) }),
      /* @__PURE__ */ jsx(StudioContext, { selected, setTab, setViewedVersionId, latestId: latest?.id, activePlatform, selectedPlatformVersionId: activePlatform ? platformSelections[activePlatform] ?? activePlatformVersion?.id : null, setSelectedPlatformVersionId: (value) => {
        if (activePlatform) setPlatformSelections((current) => ({ ...current, [activePlatform]: value }));
      }, annotationView: {
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
        onEditNote: (annotationId, x, y) => setNoteInput({ x, y, mode: "edit", annotationId, initial: annotationRows.find((row) => row.id === annotationId)?.note ?? "" }),
        onRemove: (annotationId) => {
          void removeAnnotation(annotationId);
        },
        onReopen: (annotationId) => {
          void reopenAnnotation(annotationId);
        },
        onDiscussPi: discussAnnotationsWithPi,
        busy: annotationBusy
      } }),
      annotationMenu && /* @__PURE__ */ jsx(StudioAnnotationMenu, { x: annotationMenu.x, y: annotationMenu.y, items: annotationMenuItems, onClose: () => setAnnotationMenu(null) }),
      noteInput && /* @__PURE__ */ jsx(
        StudioAnnotationNoteInput,
        {
          x: noteInput.x,
          y: noteInput.y,
          title: noteInput.mode === "create" ? "\u6807\u8BB0\u5E76\u8BF4\u660E" : "\u7F16\u8F91\u8BF4\u660E",
          initial: noteInput.mode === "edit" ? noteInput.initial : "",
          submitLabel: noteInput.mode === "create" ? "\u521B\u5EFA\u6807\u8BB0" : "\u4FDD\u5B58\u8BF4\u660E",
          busy: annotationBusy,
          onConfirm: (note) => {
            void confirmNoteInput(note);
          },
          onCancel: () => setNoteInput(null)
        }
      ),
      cropTarget ? /* @__PURE__ */ jsx(
        StudioImageCropDialog,
        {
          assetId: cropTarget.assetId,
          assetName: cropTarget.assetName,
          derive: activePlatform ? void 0 : deriveCropAsset,
          onApply: applyCropResult,
          onClose: () => setCropTarget(null)
        }
      ) : null
    ] })
  ] });
}
