// extracted from studio-view.tsx (structural split)
import { useCallback, useEffect, useMemo } from 'react';
import { contentBindingKey, type ContentMediaBindingDraft, type MediaAlign, type MediaWidthPreset } from '../shared/media-bindings';
import { htmlToMarkdown, updateAssetImageAlt, updateContentMediaBinding, type StudioAssetImageRef } from './studio-view-helpers';
import type { InlineImageDraft, InlineImageSelection } from './studio-image-toolbar';

export function useStudioInlineImages(params: {
  selected: unknown;
  coreMediaDraft: ContentMediaBindingDraft[];
  setCoreMediaDraft: React.Dispatch<React.SetStateAction<ContentMediaBindingDraft[]>>;
  editorBody: string;
  displayBody: string;
  changeBody: (next: string) => void;
  activePlatform: string | undefined | null;
  assetImageRefs: StudioAssetImageRef[];
  bodyInput: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  readOnlyVersion: unknown;
  busy: boolean;
  cropTarget: unknown;
  editorMode: string;
  richDomSyncedRef: React.MutableRefObject<boolean>;
  setMessage: (msg: string) => void;
  requestReplaceAssetImage: (ref: StudioAssetImageRef) => void;
  removeAssetImage: (ref: StudioAssetImageRef) => void;
  inlineSelection: InlineImageSelection | null;
  setInlineSelection: (v: InlineImageSelection | null) => void;
  draggedFigureRef: React.MutableRefObject<HTMLElement | null>;
  dropTargetRef: React.MutableRefObject<{ block: HTMLElement; position: 'before' | 'after' } | null>;
}) {
  const {
    selected, coreMediaDraft, setCoreMediaDraft, editorBody, displayBody, changeBody, activePlatform,
    assetImageRefs, bodyInput, canvasRef, readOnlyVersion, busy, cropTarget, richDomSyncedRef, setMessage, requestReplaceAssetImage, removeAssetImage,
    inlineSelection, setInlineSelection, draggedFigureRef, dropTargetRef
  } = params;

  const findInlineFigure = useCallback((sel: InlineImageSelection): HTMLElement | null => {
    const root = bodyInput.current;
    if (!root) return null;
    const all = [...root.querySelectorAll<HTMLElement>('figure.studio-figure')].filter((node) => node.getAttribute('data-wmb-asset') === sel.assetId);
    return all.find((node) => node.getAttribute('data-wmb-occurrence') === String(sel.occurrence)) ?? all[sel.occurrence] ?? null;
  }, [bodyInput]);

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
    const root = figure.closest('.studio-rich-editor');
    const occurrence = attrOccurrence !== null ? Number(attrOccurrence) : (root ? inlineFigureOccurrence(root, figure, assetId) : 0);
    setInlineSelection({ assetId, occurrence });
  };

  const clearInlineDropTarget = () => {
    const target = dropTargetRef.current;
    if (target) target.block.removeAttribute('data-wmb-drop-position');
    dropTargetRef.current = null;
  };

  const commitInlineFigureOrder = (root: HTMLElement, movedFigure: HTMLElement, messageText: string) => {
    const movedAssetId = movedFigure.getAttribute('data-wmb-asset');
    if (!movedAssetId) return;
    const previousBindings = new Map(coreMediaDraft.map((binding) => [contentBindingKey(binding.assetId, binding.occurrence), binding]));
    const usedBindings = new Set<string>();
    const nextBindings: ContentMediaBindingDraft[] = [];
    const seen = new Map<string, number>();
    let movedOccurrence = 0;
    for (const figure of root.querySelectorAll<HTMLElement>('figure.studio-figure')) {
      const assetId = figure.getAttribute('data-wmb-asset') ?? '';
      if (!assetId) continue;
      const oldOccurrence = Number(figure.getAttribute('data-wmb-occurrence') ?? seen.get(assetId) ?? 0);
      const newOccurrence = seen.get(assetId) ?? 0;
      seen.set(assetId, newOccurrence + 1);
      const oldKey = contentBindingKey(assetId, oldOccurrence);
      const binding = previousBindings.get(oldKey);
      if (binding) {
        nextBindings.push({ ...binding, occurrence: newOccurrence });
        usedBindings.add(oldKey);
      }
      figure.setAttribute('data-wmb-occurrence', String(newOccurrence));
      if (figure === movedFigure) movedOccurrence = newOccurrence;
    }
    if (!activePlatform) {
      const nonImageBindings = coreMediaDraft.filter((binding) => (binding.mediaKind ?? 'image') !== 'image' && !usedBindings.has(contentBindingKey(binding.assetId, binding.occurrence)));
      setCoreMediaDraft([...nextBindings, ...nonImageBindings]);
    }
    const nextBody = htmlToMarkdown(root);
    changeBody(nextBody);
    richDomSyncedRef.current = true;
    setInlineSelection({ assetId: movedAssetId, occurrence: movedOccurrence });
    setMessage(messageText);
  };

  const topLevelDropBlock = (root: HTMLElement, target: EventTarget | null, clientY: number): HTMLElement | null => {
    const dragged = draggedFigureRef.current;
    let block = target instanceof Element ? target as HTMLElement : null;
    while (block && block.parentElement !== root) block = block.parentElement;
    if (!block || block === root || block === dragged) {
      const candidates = [...root.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== dragged);
      block = candidates.reduce<HTMLElement | null>((nearest, candidate) => {
        if (!nearest) return candidate;
        const distance = Math.abs(candidate.getBoundingClientRect().top + candidate.getBoundingClientRect().height / 2 - clientY);
        const nearestRect = nearest.getBoundingClientRect();
        const nearestDistance = Math.abs(nearestRect.top + nearestRect.height / 2 - clientY);
        return distance < nearestDistance ? candidate : nearest;
      }, null);
    }
    return block;
  };

  const handleInlineFigureDragStart = (event: React.DragEvent<HTMLElement>) => {
    if (readOnlyVersion || busy || (params as unknown as { editorMode: string }).editorMode !== 'rich') return;
    const figure = (event.target as Element | null)?.closest('figure.studio-figure');
    if (!(figure instanceof HTMLElement)) return;
    draggedFigureRef.current = figure;
    figure.classList.add('studio-figure-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'wemediabuddy-inline-image');
    const assetId = figure.getAttribute('data-wmb-asset');
    if (assetId) setInlineSelection({ assetId, occurrence: Number(figure.getAttribute('data-wmb-occurrence') ?? 0) });
  };

  const handleInlineFigureDragOver = (event: React.DragEvent<HTMLElement>) => {
    const dragged = draggedFigureRef.current;
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const root = event.currentTarget;
    const block = topLevelDropBlock(root, event.target, event.clientY);
    if (!block) return;
    const rect = block.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const current = dropTargetRef.current;
    if (current?.block !== block || current.position !== position) {
      clearInlineDropTarget();
      block.setAttribute('data-wmb-drop-position', position);
      dropTargetRef.current = { block, position };
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const canvasRect = canvas.getBoundingClientRect();
      if (event.clientY < canvasRect.top + 48) canvas.scrollBy({ top: -28, behavior: 'auto' });
      else if (event.clientY > canvasRect.bottom - 48) canvas.scrollBy({ top: 28, behavior: 'auto' });
    }
  };

  const handleInlineFigureDrop = (event: React.DragEvent<HTMLElement>) => {
    const dragged = draggedFigureRef.current;
    const target = dropTargetRef.current;
    if (!dragged || !target) return;
    event.preventDefault();
    clearInlineDropTarget();
    if (target.position === 'before') target.block.before(dragged);
    else target.block.after(dragged);
    dragged.classList.remove('studio-figure-dragging');
    draggedFigureRef.current = null;
    commitInlineFigureOrder(event.currentTarget, dragged, '图片位置已调整');
  };

  const handleInlineFigureDragEnd = () => {
    clearInlineDropTarget();
    draggedFigureRef.current?.classList.remove('studio-figure-dragging');
    draggedFigureRef.current = null;
  };

  const moveInlineFigure = (direction: -1 | 1) => {
    if (!inlineSelection || readOnlyVersion || busy) return;
    const figure = findInlineFigure(inlineSelection);
    const root = bodyInput.current;
    if (!figure || !root) return;
    const sibling = direction < 0 ? figure.previousElementSibling : figure.nextElementSibling;
    if (!(sibling instanceof HTMLElement)) {
      setMessage(direction < 0 ? '图片已经在最上方' : '图片已经在最下方');
      return;
    }
    if (direction < 0) sibling.before(figure);
    else sibling.after(figure);
    commitInlineFigureOrder(root, figure, direction < 0 ? '图片已上移' : '图片已下移');
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

  const selectedInlineFigure = inlineSelection ? findInlineFigure(inlineSelection) : null;
  const canMoveInlineUp = Boolean(selectedInlineFigure?.previousElementSibling);
  const canMoveInlineDown = Boolean(selectedInlineFigure?.nextElementSibling);

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
    window.dispatchEvent(new CustomEvent('studio-inline-crop-request', { detail: { assetId: inlineSelection.assetId, occurrence: inlineSelection.occurrence } }));
  };

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

  return {
    findInlineFigure, handleInlineFigureClick,
    handleInlineFigureDragStart, handleInlineFigureDragOver, handleInlineFigureDrop, handleInlineFigureDragEnd,
    moveInlineFigure,
    inlineDraft, inlineAlt, canMoveInlineUp, canMoveInlineDown,
    handleInlineWidth, handleInlineAlign, handleInlineReplace, handleInlineCaption, handleInlineRemove, handleInlineCrop
  };
}
