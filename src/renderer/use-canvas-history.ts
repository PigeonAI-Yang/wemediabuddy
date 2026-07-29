import { useState } from 'react';
import type { CanvasAction } from './knowledge-canvas-types';

export function useCanvasHistory(canvas: any, setCanvas: (value: any) => void, loadCanvas: (id: string) => Promise<void>) {
  const [undoStack, setUndoStack] = useState<CanvasAction[]>([]);
  const [redoStack, setRedoStack] = useState<CanvasAction[]>([]);
  const updateViewport = async (input: { viewportX?: number; viewportY?: number; zoom?: number }) => {
    if (!canvas) return;
    setCanvas(await window.wmb.updateKnowledgeCanvas({ id: canvas.id, expectedRevision: canvas.revision, ...input }));
  };
  const remember = (action: CanvasAction) => {
    setUndoStack((items) => [...items, action]);
    setRedoStack([]);
  };
  const applyHistory = async (action: CanvasAction, direction: 'undo' | 'redo') => {
    if (!canvas) return;
    const latest = await window.wmb.getKnowledgeCanvas(canvas.id);
    if (action.kind === 'move') {
      const point = direction === 'undo' ? action.before : action.after;
      const node = latest.nodes.find((item: any) => item.id === action.nodeId);
      if (!node) return;
      setCanvas(await window.wmb.moveKnowledgeCanvasNodes({
        canvasId: latest.id,
        nodes: [{ id: node.id, ...point, expectedRevision: node.revision }]
      }));
      return;
    }
    const value = direction === 'undo' ? action.before : action.after;
    const relation = latest.relations.find((item: any) => item.id === action.id);
    if (!relation) return;
    await window.wmb.updateKnowledgeRelation({ id: relation.id, expectedRevision: relation.revision, ...value });
    await loadCanvas(latest.id);
  };
  const undo = async () => {
    const action = undoStack.at(-1);
    if (!action) return;
    await applyHistory(action, 'undo');
    setUndoStack((items) => items.slice(0, -1));
    setRedoStack((items) => [...items, action]);
  };
  const redo = async () => {
    const action = redoStack.at(-1);
    if (!action) return;
    await applyHistory(action, 'redo');
    setRedoStack((items) => items.slice(0, -1));
    setUndoStack((items) => [...items, action]);
  };
  return { undoStack, redoStack, updateViewport, remember, undo, redo };
}
