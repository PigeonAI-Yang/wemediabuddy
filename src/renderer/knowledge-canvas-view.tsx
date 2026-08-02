import { useEffect, useRef, useState } from "react";
import { KnowledgeCanvasLayout } from "./knowledge-canvas-layout";
import { useCanvasHistory } from "./use-canvas-history";
import { relationNames } from "./knowledge-canvas-types";

export function KnowledgeCanvasView({
  initialCanvasId,
  onContextChange,
  onDiscuss,
}: {
  initialCanvasId?: string | null;
  onContextChange: (
    item: {
      canvasId: string;
      nodeIds: string[];
      mode: "current_page" | "selected";
      title: string;
    } | null,
  ) => void;
  onDiscuss: () => void;
}) {
  const [canvases, setCanvases] = useState<any[]>([]);
  const [canvas, setCanvas] = useState<any>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [connecting, setConnecting] = useState<{
    fromNodeId: string;
    targetNodeId: string | null;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const [keyboardConnectionSource, setKeyboardConnectionSource] = useState<
    string | null
  >(null);
  const [pendingRelation, setPendingRelation] = useState<{
    fromNodeId: string;
    toNodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<any | null>(null);
  const [drawer, setDrawer] = useState<"assets" | null>(null);
  const [message, setMessage] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [mode, setMode] = useState<"select" | "pan">("select");
  const boardRef = useRef<HTMLDivElement>(null);

  const loadCanvas = async (id: string) => {
    const next = await window.wmb.getKnowledgeCanvas(id);
    setCanvas(next);
    requestAnimationFrame(() => {
      if (boardRef.current) {
        boardRef.current.scrollLeft = next.viewportX;
        boardRef.current.scrollTop = next.viewportY;
      }
    });
  };
  useEffect(() => {
    void Promise.all([
      window.wmb.listKnowledgeCanvases(),
      window.wmb.listKnowledgeSources({ limit: 50 }),
      window.wmb.listKnowledgeTopics({ limit: 50 }),
    ]).then(async ([list, sourcePage, topicPage]) => {
      setSources(sourcePage?.items ?? []);
      setTopics(topicPage?.items ?? []);
      const next = list;
      setCanvases(next);
      const target =
        next.find((item: any) => item.id === initialCanvasId) ?? next[0];
      if (target) await loadCanvas(target.id);
      else setCanvas(null);
    });
  }, []);
  useEffect(() => {
    if (!canvas?.id) return;
    const id = canvas.id,
      timer = window.setInterval(
        () =>
          void window.wmb
            .getKnowledgeCanvas(id)
            .then((next) =>
              setCanvas((current: any) =>
                current?.id === id ? next : current,
              ),
            ),
        5000,
      );
    return () => window.clearInterval(timer);
  }, [canvas?.id]);
  useEffect(() => {
    if (!canvas) {
      onContextChange(null);
      return;
    }
    onContextChange({
      canvasId: canvas.id,
      nodeIds: selected.length
        ? selected
        : canvas.nodes.map((node: any) => node.id),
      mode: selected.length ? "selected" : "current_page",
      title: canvas.title,
    });
  }, [canvas?.id, canvas?.title, canvas?.nodes.length, selected.join(",")]);
  const refreshCanvasList = async () =>
    setCanvases(await window.wmb.listKnowledgeCanvases());
  const createCanvas = async () => {
    const title = window.prompt("画布名称");
    if (!title) return;
    const next = await window.wmb.createKnowledgeCanvas({ title });
    await refreshCanvasList();
    await loadCanvas(next.id);
  };
  const renameCanvas = async () => {
    if (!canvas) return;
    const title = window.prompt("画布名称", canvas.title);
    if (!title || title === canvas.title) return;
    setCanvas(
      await window.wmb.updateKnowledgeCanvas({
        id: canvas.id,
        expectedRevision: canvas.revision,
        title,
      }),
    );
    await refreshCanvasList();
  };
  const { undoStack, redoStack, updateViewport, remember, undo, redo } = useCanvasHistory(canvas, setCanvas, loadCanvas);

  const addObject = async (
    objectType: "source" | "topic",
    objectId: string,
  ) => {
    if (!canvas) return;
    await window.wmb.addKnowledgeCanvasNode({
      canvasId: canvas.id,
      objectType,
      objectId,
      x: 80 + (canvas.nodes.length % 4) * 280,
      y: 90 + Math.floor(canvas.nodes.length / 4) * 190,
    });
    await loadCanvas(canvas.id);
  };
  const addNote = async () => {
    if (!canvas) return;
    const title = window.prompt("笔记标题");
    if (!title) return;
    const noteText = window.prompt("笔记内容") ?? "";
    await window.wmb.addKnowledgeCanvasNode({
      canvasId: canvas.id,
      objectType: "note",
      noteTitle: title,
      noteText,
      x: 80 + (canvas.nodes.length % 4) * 280,
      y: 90 + Math.floor(canvas.nodes.length / 4) * 190,
    });
    await loadCanvas(canvas.id);
  };
  const createRelation = async (relationType: string) => {
    if (!pendingRelation || !canvas) return;
    await window.wmb.createKnowledgeRelation({
      canvasId: canvas.id,
      fromNodeId: pendingRelation.fromNodeId,
      toNodeId: pendingRelation.toNodeId,
      relationType,
    });
    setPendingRelation(null);
    setConnecting(null);
    await loadCanvas(canvas.id);
    setMessage(`已建立“${relationNames[relationType]}”关系`);
  };
  const connectByKeyboard = (node: any) => {
    if (!canvas) return;
    if (!keyboardConnectionSource) {
      setKeyboardConnectionSource(node.id);
      setMessage(
        `已选择“${node.object.title}”作为关系起点，请在另一个节点的关系按钮上按回车`,
      );
      return;
    }
    if (keyboardConnectionSource === node.id) {
      setKeyboardConnectionSource(null);
      setMessage("已取消建立关系");
      return;
    }
    setPendingRelation({
      fromNodeId: keyboardConnectionSource,
      toNodeId: node.id,
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    });
    setKeyboardConnectionSource(null);
  };
  const saveRelation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRelation || !canvas) return;
    const data = new FormData(event.currentTarget);
    const after = {
      fromNodeId: String(data.get("fromNodeId")),
      toNodeId: String(data.get("toNodeId")),
      relationType: String(data.get("relationType")),
      label: String(data.get("label") ?? "") || null,
      hidden: Boolean(selectedRelation.hidden),
    };
    await window.wmb.updateKnowledgeRelation({
      id: selectedRelation.id,
      expectedRevision: selectedRelation.revision,
      ...after,
    });
    remember({
      kind: "relation",
      id: selectedRelation.id,
      before: {
        fromNodeId: selectedRelation.fromNodeId,
        toNodeId: selectedRelation.toNodeId,
        relationType: selectedRelation.relationType,
        label: selectedRelation.label,
        hidden: Boolean(selectedRelation.hidden),
      },
      after,
    });
    setSelectedRelation(null);
    await loadCanvas(canvas.id);
    setMessage("关系已更新");
  };
  const hideRelation = async () => {
    if (!selectedRelation || !canvas) return;
    const after = {
      fromNodeId: selectedRelation.fromNodeId,
      toNodeId: selectedRelation.toNodeId,
      relationType: selectedRelation.relationType,
      label: selectedRelation.label,
      hidden: !Boolean(selectedRelation.hidden),
    };
    await window.wmb.updateKnowledgeRelation({
      id: selectedRelation.id,
      expectedRevision: selectedRelation.revision,
      hidden: after.hidden,
    });
    remember({
      kind: "relation",
      id: selectedRelation.id,
      before: { ...after, hidden: Boolean(selectedRelation.hidden) },
      after,
    });
    setSelectedRelation(null);
    await loadCanvas(canvas.id);
  };
  const archiveRelation = async () => {
    if (!selectedRelation || !canvas) return;
    await window.wmb.updateKnowledgeRelation({
      id: selectedRelation.id,
      expectedRevision: selectedRelation.revision,
      archived: true,
    });
    setSelectedRelation(null);
    await loadCanvas(canvas.id);
    setMessage("关系已删除");
  };
  const decideSuggestion = async (
    item: any,
    decision: "confirm" | "reject",
  ) => {
    if (!canvas) return;
    await window.wmb.decideKnowledgeSuggestion({
      requestId: crypto.randomUUID(),
      id: item.id,
      expectedRevision: item.revision,
      decision,
    });
    await loadCanvas(canvas.id);
    setMessage(
      decision === "confirm"
        ? "建议已确认并写入画布"
        : "建议已拒绝，未写入知识",
    );
  };
  const beginConnection = (event: React.PointerEvent, node: any) => {
    event.preventDefault();
    event.stopPropagation();
    const board = boardRef.current;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const zoom = canvas.zoom ?? 1,
      x1 = (node.x + node.width) * zoom,
      y1 = (node.y + node.height / 2) * zoom;
    const findTarget = (pointer: PointerEvent) => {
      const direct = (
        document.elementFromPoint(
          pointer.clientX,
          pointer.clientY,
        ) as HTMLElement | null
      )?.closest<HTMLElement>("[data-kc-node-id]");
      if (direct?.dataset.kcNodeId !== node.id)
        return direct?.dataset.kcNodeId ?? null;
      let nearest: string | null = null,
        distance = 28;
      document
        .querySelectorAll<HTMLElement>("[data-kc-node-id]")
        .forEach((element) => {
          if (element.dataset.kcNodeId === node.id) return;
          const bounds = element.getBoundingClientRect();
          const dx = Math.max(
            bounds.left - pointer.clientX,
            0,
            pointer.clientX - bounds.right,
          );
          const dy = Math.max(
            bounds.top - pointer.clientY,
            0,
            pointer.clientY - bounds.bottom,
          );
          const next = Math.hypot(dx, dy);
          if (next < distance) {
            distance = next;
            nearest = element.dataset.kcNodeId ?? null;
          }
        });
      return nearest;
    };
    setConnecting({
      fromNodeId: node.id,
      targetNodeId: null,
      x1,
      y1,
      x2: x1,
      y2: y1,
    });
    const move = (pointer: PointerEvent) =>
      setConnecting((current) =>
        current
          ? {
              ...current,
              targetNodeId: findTarget(pointer),
              x2: pointer.clientX - rect.left + board.scrollLeft,
              y2: pointer.clientY - rect.top + board.scrollTop,
            }
          : null,
      );
    const stop = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      const toNodeId = findTarget(pointer);
      const x = pointer.clientX - rect.left + board.scrollLeft,
        y = pointer.clientY - rect.top + board.scrollTop;
      if (toNodeId && toNodeId !== node.id)
        setPendingRelation({ fromNodeId: node.id, toNodeId, x, y });
      else {
        setConnecting(null);
        setMessage("请把连线拖到另一个节点上");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  const beginDrag = (event: React.PointerEvent, node: any) => {
    if ((event.target as HTMLElement).closest(".kc-port,.kc-node-check"))
      return;
    event.stopPropagation();
    const startX = event.clientX,
      startY = event.clientY,
      originX = node.x,
      originY = node.y;
    if (!selected.includes(node.id))
      setSelected(event.shiftKey ? [...selected, node.id] : [node.id]);
    const zoom = canvas.zoom ?? 1;
    const move = (pointer: PointerEvent) =>
      setCanvas((current: any) => ({
        ...current,
        nodes: current.nodes.map((item: any) =>
          item.id === node.id
            ? {
                ...item,
                x: originX + (pointer.clientX - startX) / zoom,
                y: originY + (pointer.clientY - startY) / zoom,
              }
            : item,
        ),
      }));
    const stop = async (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      const x = originX + (pointer.clientX - startX) / zoom,
        y = originY + (pointer.clientY - startY) / zoom;
      const next = await window.wmb.moveKnowledgeCanvasNodes({
        canvasId: canvas.id,
        nodes: [{ id: node.id, x, y, expectedRevision: node.revision }],
      });
      setCanvas(next);
      if (x !== originX || y !== originY)
        remember({
          kind: "move",
          nodeId: node.id,
          before: { x: originX, y: originY },
          after: { x, y },
        });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  const beginBox = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (mode === "pan") {
      const board = event.currentTarget,
        startX = event.clientX,
        startY = event.clientY,
        left = board.scrollLeft,
        top = board.scrollTop;
      const move = (pointer: PointerEvent) => {
        board.scrollLeft = left - (pointer.clientX - startX);
        board.scrollTop = top - (pointer.clientY - startY);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        void updateViewport({
          viewportX: board.scrollLeft,
          viewportY: board.scrollTop,
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect(),
      zoom = canvas.zoom ?? 1,
      x = (event.clientX - bounds.left) / zoom,
      y = (event.clientY - bounds.top) / zoom;
    setBox({ x, y, left: x, top: y, width: 0, height: 0 });
    const move = (pointer: PointerEvent) => {
      const px = (pointer.clientX - bounds.left) / zoom,
        py = (pointer.clientY - bounds.top) / zoom;
      setBox({
        x,
        y,
        left: Math.min(x, px) * zoom,
        top: Math.min(y, py) * zoom,
        width: Math.abs(px - x) * zoom,
        height: Math.abs(py - y) * zoom,
      });
    };
    const stop = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      const px = (pointer.clientX - bounds.left) / zoom,
        py = (pointer.clientY - bounds.top) / zoom;
      const left = Math.min(x, px),
        right = Math.max(x, px),
        top = Math.min(y, py),
        bottom = Math.max(y, py);
      const hits = canvas.nodes
        .filter(
          (node: any) =>
            node.x + node.width >= left &&
            node.x <= right &&
            node.y + node.height >= top &&
            node.y <= bottom,
        )
        .map((node: any) => node.id);
      setSelected(event.shiftKey ? [...new Set([...selected, ...hits])] : hits);
      setBox(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  return <KnowledgeCanvasLayout c={{ canvases, canvas, sources, topics, selected, box, connecting, pendingRelation, selectedRelation, drawer, assetQuery, mode, undoStack, redoStack, boardRef, setCanvas, setSelected, setBox, setConnecting, setKeyboardConnectionSource, setPendingRelation, setSelectedRelation, setDrawer, setAssetQuery, setMode, loadCanvas, createCanvas, renameCanvas, updateViewport, undo, redo, addObject, addNote, createRelation, connectByKeyboard, saveRelation, hideRelation, archiveRelation, decideSuggestion, beginConnection, beginDrag, beginBox, onDiscuss }} />;
}
