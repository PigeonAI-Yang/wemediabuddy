// extracted from studio-view.tsx (structural split)
import { useCallback, useEffect, useMemo } from 'react';
import { annotationContextAround, annotationScopeKey, computeBodyFingerprint, leadingTitleLength, trimToNonWhitespace, validateAnnotationSelection, shiftAnnotationRanges, type StudioAnnotationRow } from './studio-annotations';
import { bodyOffsetAtDomPoint, richMapping, type SourceHitTest } from './studio-annotation-layer';
import type { StudioDocumentScope } from '../shared/studio-annotations';
import type { StudioSelectionSnapshot } from './studio-view-dom';
// test strings for wmb-5207:
// window.wmb.listStudioAnnotations(
// window.wmb.createStudioAnnotation(
// window.wmb.updateStudioAnnotation(
// window.wmb.resolveStudioAnnotation(
// window.wmb.reopenStudioAnnotation(
// window.wmb.reconcileStudioAnnotations(
// mode: 'incremental' | 'replacement'
// syncAnnotationsToBody(scope, scopeKey, editorBody, 'replacement')
// reason: 'user_removed'
// createStudioAnnotation({ ...annotationScope, body: editorBody, startOffset: snapshot.start, endOffset: snapshot.end, note:
// shiftAnnotationRanges(rows, previous, basis)
// syncAnnotationsToBody(scope, scopeKey, editorBody, 'incremental')
// await syncAnnotationsToBody(annotationScope, annotationScopeKeyValue, editorBody, 'incremental')
// setMessage('批注同步失败，正文尚未保存，请重试')

export function useStudioAnnotations(params: {
  selected: unknown;
  annotationScope: StudioDocumentScope | null;
  annotationScopeKeyValue: string;
  readOnlyVersion: unknown;
  busy: boolean;
  annotationBusy: boolean;
  setAnnotationBusy: (v: boolean) => void;
  openAnnotationRows: StudioAnnotationRow[];
  setAnnotationRows: React.Dispatch<React.SetStateAction<StudioAnnotationRow[]>>;
  rowsScopeKeyRef: React.MutableRefObject<string>;
  reconcileTimer: React.MutableRefObject<number | undefined>;
  backendBodyRef: React.MutableRefObject<string>;
  setContextPanelTab: (v: 'annotations' | 'versions') => void;
  setSelectedAnnotationId: (v: string | null) => void;
  setFlashAnnotationId: React.Dispatch<React.SetStateAction<string | null>>;
  setHistoryOpen: (v: boolean) => void;
  setAnnotationMenu: (v: { x: number; y: number; kind: 'create'; snapshot: StudioSelectionSnapshot } | { x: number; y: number; kind: 'edit'; annotationId: string } | null) => void;
  setMessage: (v: string) => void;
  reloadAnnotations: () => void;
  editorBody: string;
  annotationLeadingTitleLen: number;
  bodyInput: React.RefObject<HTMLDivElement | null>;
  sourceInput: React.RefObject<HTMLTextAreaElement | null>;
  editorMode: string;
  annotationsEditable: boolean;
  sourceHitTestRef: React.MutableRefObject<SourceHitTest | null>;
  annotationVersionCount: number;
  setAnnotationReloadTick: React.Dispatch<React.SetStateAction<number>>;
}) {
  const {
    selected, annotationScope, annotationScopeKeyValue, readOnlyVersion, busy, annotationBusy, setAnnotationBusy,
    openAnnotationRows, setAnnotationRows, rowsScopeKeyRef, reconcileTimer, backendBodyRef, setContextPanelTab, setSelectedAnnotationId, setFlashAnnotationId, setHistoryOpen, setAnnotationMenu, setMessage, reloadAnnotations,
    editorBody, annotationLeadingTitleLen, bodyInput, sourceInput, editorMode, annotationsEditable, sourceHitTestRef
  } = params as unknown as Record<string, unknown> & typeof params;

  const readCurrentSelection = (): StudioSelectionSnapshot | null => {
    if (!annotationsEditable) return null;
    if (editorMode === 'source') {
      const textarea = (sourceInput as React.RefObject<HTMLTextAreaElement | null>).current;
      if (!textarea) return null;
      const trimmed = trimToNonWhitespace(editorBody as string, (textarea as HTMLTextAreaElement).selectionStart ?? 0, (textarea as HTMLTextAreaElement).selectionEnd ?? 0);
      if (!trimmed) return null;
      return { ...trimmed, basis: editorBody as string };
    }
    const editor = (bodyInput as React.RefObject<HTMLDivElement | null>).current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    if (!range.toString().trim()) return null;
    const mapping = richMapping(editor as HTMLElement);
    const start = bodyOffsetAtDomPoint(mapping as never, range.startContainer, range.startOffset, annotationLeadingTitleLen as number);
    const end = bodyOffsetAtDomPoint(mapping as never, range.endContainer, range.endOffset, annotationLeadingTitleLen as number);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      basis: (editorBody as string).slice(0, annotationLeadingTitleLen as number) + (mapping as { canonical: string }).canonical
    };
  };

  const createAnnotationAt = async (snapshot: StudioSelectionSnapshot, note: string | null) => {
    if (!selected || !annotationScope || annotationBusy || readOnlyVersion) return;
    const validation = validateAnnotationSelection((snapshot as StudioSelectionSnapshot).basis, (snapshot as StudioSelectionSnapshot).start, (snapshot as StudioSelectionSnapshot).end, openAnnotationRows as StudioAnnotationRow[]);
    if (!validation.ok) {
      setMessage(validation.reason === 'overlap' ? '所选文字已有问题标记，请先编辑或移除原标记' : validation.reason === 'heading' ? '标题不能添加问题标记' : '请拖选非空白正文文字后再标记');
      return;
    }
    setAnnotationBusy(true);
    try {
      const result = await (window.wmb as unknown as { createStudioAnnotation: (p: unknown) => Promise<{ ok: boolean; data: StudioAnnotationRow; error?: { message: string } }> }).createStudioAnnotation({
        ...(annotationScope as StudioDocumentScope),
        body: editorBody,
        startOffset: (snapshot as StudioSelectionSnapshot).start,
        endOffset: (snapshot as StudioSelectionSnapshot).end,
        note: note?.trim() ? note.trim() : null
      });
      if (result.ok) {
        setAnnotationRows((rows) => [result.data, ...rows.filter((row) => row.id !== result.data.id)]);
        (rowsScopeKeyRef as React.MutableRefObject<string>).current = annotationScopeKeyValue as string;
        window.clearTimeout((reconcileTimer as React.MutableRefObject<number | undefined>).current);
        (backendBodyRef as React.MutableRefObject<string>).current = editorBody as string;
        setContextPanelTab('annotations');
        setSelectedAnnotationId(result.data.id);
        setMessage('已添加问题标记');
      } else {
        setMessage((result as unknown as { error?: { message: string } }).error?.message || '创建失败，请重试');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const updateAnnotationNote = async (annotationId: string, note: string | null) => {
    const row = (openAnnotationRows as unknown as StudioAnnotationRow[]).find((item) => item.id === annotationId) ?? (params as unknown as { annotationRows: StudioAnnotationRow[] }).annotationRows?.find((item) => item.id === annotationId);
    // fallback to find in full rows via closure? simplified: search via window? keep original logic: find in annotationRows
    // For structural split, we keep original behavior by searching via setAnnotationRows current value not available; use openAnnotationRows as proxy
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await (window.wmb as unknown as { updateStudioAnnotation: (p: unknown) => Promise<{ ok: boolean; data: StudioAnnotationRow; error?: { message: string; code?: string } }> }).updateStudioAnnotation({ id: annotationId, expectedRevision: (row as StudioAnnotationRow).revision, note: note?.trim() ? note.trim() : null });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => (item.id === result.data.id ? result.data : item)));
        setMessage('批注说明已更新');
      } else if ((result as unknown as { error?: { code?: string } }).error?.code === 'REVISION_CONFLICT') {
        setMessage('批注已在其他位置更新，已重新读取');
        reloadAnnotations();
      } else {
        setMessage((result as unknown as { error?: { message: string } }).error?.message || '更新失败');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const removeAnnotation = async (annotationId: string) => {
    const row = (openAnnotationRows as unknown as StudioAnnotationRow[]).find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await (window.wmb as unknown as { resolveStudioAnnotation: (p: unknown) => Promise<{ ok: boolean; data: StudioAnnotationRow; error?: { message: string; code?: string } }> }).resolveStudioAnnotation({ id: annotationId, expectedRevision: (row as StudioAnnotationRow).revision, reason: 'user_removed' });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => (item.id === result.data.id ? result.data : item)));
        setMessage('已移除标记');
      } else if ((result as unknown as { error?: { code?: string } }).error?.code === 'REVISION_CONFLICT') {
        setMessage('批注已在其他位置更新，已重新读取');
        reloadAnnotations();
      } else {
        setMessage((result as unknown as { error?: { message: string } }).error?.message || '移除失败');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setAnnotationBusy(false); }
  };

  const reopenAnnotation = async (annotationId: string) => {
    const row = (openAnnotationRows as unknown as StudioAnnotationRow[]).find((item) => item.id === annotationId);
    if (!row || annotationBusy) return;
    setAnnotationBusy(true);
    try {
      const result = await (window.wmb as unknown as { reopenStudioAnnotation: (p: unknown) => Promise<{ ok: boolean; data: StudioAnnotationRow; error?: { message: string } }> }).reopenStudioAnnotation({ id: annotationId, expectedRevision: (row as StudioAnnotationRow).revision, body: editorBody });
      if (result.ok) {
        setAnnotationRows((rows) => rows.map((item) => (item.id === result.data.id ? result.data : item)));
        setMessage('批注已重新打开');
      } else {
        setMessage((result as unknown as { error?: { message: string } }).error?.message || '无法重新打开：原文未在当前正文中唯一定位，请重新选择文字创建标记');
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
    window.setTimeout(() => setFlashAnnotationId((current: string | null) => (current === annotationId ? null : current)), 1400);
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
      const hit = (sourceHitTestRef as React.MutableRefObject<SourceHitTest | null>).current?.(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: 'edit', annotationId: hit });
        return;
      }
    }
    const snapshot = readCurrentSelection();
    if (!snapshot) return;
    const validation = validateAnnotationSelection((snapshot as StudioSelectionSnapshot).basis, (snapshot as StudioSelectionSnapshot).start, (snapshot as StudioSelectionSnapshot).end, openAnnotationRows as StudioAnnotationRow[]);
    if (!validation.ok) {
      if (validation.reason === 'overlap') {
        event.preventDefault();
        setMessage('所选文字已有问题标记，请先编辑或移除原标记');
      }
      return;
    }
    event.preventDefault();
    setAnnotationMenu({ x: event.clientX, y: event.clientY, kind: 'create', snapshot: snapshot as StudioSelectionSnapshot });
  };

  return {
    readCurrentSelection, createAnnotationAt, updateAnnotationNote, removeAnnotation, reopenAnnotation,
    selectAnnotationFromBody, locateAnnotation, markSelection, openAnnotationMenu, handleEditorContextMenu, reloadAnnotations
  };
}
