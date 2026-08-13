import { useEffect, useMemo, useRef, useState } from "react";
import { KnowledgeCanvasLayout } from "./knowledge-canvas-layout";
import { useCanvasHistory } from "./use-canvas-history";
import { relationNames } from "./knowledge-canvas-types";
import {
  issuesForNode,
  keepSelection,
  maxIssueSeverity,
  mergeCanvasRefresh,
  mergeProjectionEmphasis,
  selectionModeFor,
  shouldRefreshCanvas,
  type ProjectionIssueLike,
} from "./knowledge-canvas-projection";
import type {
  KnowledgeCanvasDeepLink,
  KnowledgeCanvasNodeDetail,
  KnowledgeCanvasProjection,
  KnowledgeCanvasProjectionMode,
  KnowledgeCanvasSelectionManifest,
} from "../shared/knowledge-canvas";

export type CanvasDetailTarget = {
  type: "topic" | "source" | "studio" | "results";
  id?: string;
  title?: string;
};

type CanvasNodeShape = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  revision: number;
  objectType: string;
  objectId: string | null;
  noteTitle: string | null;
  noteText: string | null;
  changes?: readonly unknown[];
  healthIssueIds?: readonly string[];
  deepLink?: unknown;
  object: {
    id: string;
    title: string;
    body: string;
    revision: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type CanvasRecord = {
  id: string;
  title: string;
  viewportX: number;
  viewportY: number;
  zoom: number;
  revision: number;
  nodes: CanvasNodeShape[];
  relations: Array<Record<string, unknown>>;
  suggestions: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export function KnowledgeCanvasView({
  initialCanvasId,
  onContextChange,
  onDiscuss,
  onOpenDetail,
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
  onOpenDetail?: (target: CanvasDetailTarget) => void;
}) {
  const [canvases, setCanvases] = useState<any[]>([]);
  const [canvas, setCanvas] = useState<CanvasRecord | null>(null);
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
  const [selectedRelation, setSelectedRelation] = useState<
    | {
        id: string;
        fromNodeId: string;
        toNodeId: string;
        relationType: string;
        label: string | null;
        hidden: boolean;
        revision: number;
        [key: string]: unknown;
      }
    | null
  >(null);
  const [drawer, setDrawer] = useState<"assets" | "detail" | null>(null);
  const [message, setMessage] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [mode, setMode] = useState<"select" | "pan">("select");
  // WMB-5213：三模式投影（关系/变化/健康）+ 详情 + selected-only 动作。
  const [projectionMode, setProjectionMode] =
    useState<KnowledgeCanvasProjectionMode>("relation");
  const [projection, setProjection] =
    useState<KnowledgeCanvasProjection | null>(null);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(
    null,
  );
  const [changeSetList, setChangeSetList] = useState<
    readonly {
      id: string;
      reason: string;
      createdAt: string;
      triggerSource: string;
    }[]
  >([]);
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] =
    useState<KnowledgeCanvasNodeDetail | null>(null);
  const [manifest, setManifest] =
    useState<KnowledgeCanvasSelectionManifest | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefForm, setBriefForm] = useState<{
    title: string;
    coreJudgment: string;
    whyNow: string;
    structure: string;
    existingBriefId?: string;
    expectedRevision?: number;
  }>({ title: "", coreJudgment: "", whyNow: "", structure: "" });
  const [refreshAnnounce, setRefreshAnnounce] = useState("");
  // 节点常驻状态：topic 的 Wiki 编译态 + 健康问题（三模式都可见）。
  const [knowledgeOverview, setKnowledgeOverview] = useState<{
    wikiPages: Record<string, { compileStatus?: string }>;
    issues: readonly ProjectionIssueLike[];
  }>({ wikiPages: {}, issues: [] });
  const boardRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string[]>([]);
  selectedRef.current = selected;

  const loadCanvas = async (
    id: string,
    options: { preserveViewport?: boolean } = {},
  ) => {
    const [next, proj, overview] = await Promise.all([
      window.wmb.getKnowledgeCanvas(id),
      window.wmb.getKnowledgeCanvasProjection({
        canvasId: id,
        mode: projectionMode,
      }),
      loadKnowledgeOverview(),
    ]);
    setCanvas((current) =>
      current?.id === id ? mergeCanvasRefresh(current, next) : next,
    );
    setProjection(proj);
    setKnowledgeOverview(overview);
    setSelected((current) => keepSelection(current, next.nodes));
    if (!options.preserveViewport) {
      requestAnimationFrame(() => {
        if (boardRef.current) {
          boardRef.current.scrollLeft = next.viewportX;
          boardRef.current.scrollTop = next.viewportY;
        }
      });
    }
  };
  const loadKnowledgeOverview = async (): Promise<{
    wikiPages: Record<string, { compileStatus?: string }>;
    issues: readonly ProjectionIssueLike[];
  }> => {
    const [pages, issues] = await Promise.all([
      window.wmb.listWikiPages({ limit: 100 }),
      window.wmb.listHealthIssues({ limit: 100 }),
    ]);
    const wikiPages: Record<string, { compileStatus?: string }> = {};
    for (const page of pages?.items ?? []) {
      if (page.subjectType === "topic" && page.subjectId)
        wikiPages[page.subjectId] = { compileStatus: page.compileStatus };
    }
    return { wikiPages, issues: issues?.items ?? [] };
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
  // WMB-5213：dataChanged 订阅替代 5 秒轮询作为主路径（设计 §5.3）。
  // 刷新合并新对象状态但保留 selection/viewport/drawer/连接编辑；focus 恢复只做事件兜底。
  useEffect(() => {
    const refresh = () => void refreshSilently();
    const unsubscribe = window.wmb.onDataChanged?.((event) => {
      if (shouldRefreshCanvas(event.scopes)) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", refresh);
    };
  }, [canvas?.id, projectionMode]);
  const refreshSilently = async () => {
    if (!canvas?.id) return;
    const id = canvas.id;
    try {
      const [next, proj, overview] = await Promise.all([
        window.wmb.getKnowledgeCanvas(id),
        window.wmb.getKnowledgeCanvasProjection({
          canvasId: id,
          mode: projectionMode,
        }),
        loadKnowledgeOverview(),
      ]);
      setCanvas((current) =>
        current?.id === id ? mergeCanvasRefresh(current, next) : current,
      );
      setProjection(proj);
      setKnowledgeOverview(overview);
      setSelected((current) => keepSelection(current, next.nodes));
      setConnecting((current) =>
        current && next.nodes.some((node: any) => node.id === current.fromNodeId)
          ? current
          : null,
      );
      setPendingRelation((current) =>
        current &&
        next.nodes.some((node: any) => node.id === current.fromNodeId) &&
        next.nodes.some((node: any) => node.id === current.toNodeId)
          ? current
          : null,
      );
      setKeyboardConnectionSource((current) =>
        current && next.nodes.some((node: any) => node.id === current)
          ? current
          : null,
      );
      setSelectedRelation((current) =>
        current && next.relations.some((item: any) => item.id === current.id)
          ? current
          : null,
      );
      if (detailNodeId && next.nodes.some((node: any) => node.id === detailNodeId)) {
        void openNodeDetail(detailNodeId);
      } else if (detailNodeId) {
        setDetailNodeId(null);
        setNodeDetail(null);
      }
      if (proj?.updatedAt && proj.updatedAt !== projection?.updatedAt) {
        setRefreshAnnounce(
          `画布已同步：${new Date(proj.updatedAt).toLocaleTimeString()} 的知识状态`,
        );
      }
    } catch {
      // 静默刷新失败不打断交互；下次 dataChanged/focus 会重试。
    }
  };
  // 画布切换：清空跨画布不存在的交互状态（选择/详情/关系编辑）。
  useEffect(() => {
    setSelected([]);
    setDetailNodeId(null);
    setNodeDetail(null);
    setSelectedRelation(null);
    setPendingRelation(null);
    setConnecting(null);
    setKeyboardConnectionSource(null);
    setBriefOpen(false);
  }, [canvas?.id]);
  useEffect(() => {
    if (!canvas?.id) return;
    void window.wmb
      .getKnowledgeCanvasProjection({
        canvasId: canvas.id,
        mode: projectionMode,
        changeSetId:
          projectionMode === "change" && selectedChangeSetId
            ? selectedChangeSetId
            : undefined,
      })
      .then(setProjection);
    if (projectionMode === "change") {
      void window.wmb
        .listChangeSets({ limit: 20 })
        .then((page) => setChangeSetList(page?.items ?? []));
    }
  }, [canvas?.id, projectionMode, selectedChangeSetId]);
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
  // selected-only 动作的规范输入清单：展示与实际传入同一份（服务端拒绝越界/重复）。
  useEffect(() => {
    if (!canvas?.id) {
      setManifest(null);
      return;
    }
    const nodeIds = selectedRef.current.length
      ? selectedRef.current
      : canvas.nodes.map((node: any) => node.id);
    if (!nodeIds.length) {
      setManifest(null);
      return;
    }
    let cancelled = false;
    void window.wmb
      .validateKnowledgeSelectionManifest({ canvasId: canvas.id, nodeIds })
      .then((value) => {
        if (!cancelled) setManifest(value);
      })
      .catch(() => {
        if (!cancelled) setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canvas?.id, canvas?.nodes.length, selected.join(",")]);
  const viewCanvas = useMemo(
    () => mergeProjectionEmphasis(canvas, projection),
    [canvas, projection],
  );
  // 常驻状态投影：topic 的 Wiki 编译态 + 健康严重度（关系/变化/健康三模式同规则）。
  // WMB-5233：优先用投影节点携带的诚实三态（uncompiled/legacy_shell/compiled）；
  // 投影未就绪时回退 listWikiPages 的 compileStatus 旧行为。
  const nodeStatus = useMemo(() => {
    const map: Record<
      string,
      { compileStatus?: string; compileState?: string; issueCount: number; maxSeverity: string | null }
    > = {};
    for (const node of (viewCanvas?.nodes ?? []) as Array<{
      id: string;
      objectType?: string;
      objectId?: string | null;
      compileState?: string;
      [key: string]: unknown;
    }>) {
      const issues = issuesForNode(knowledgeOverview.issues, node);
      const topicWiki = node.objectType === "topic" && node.objectId
        ? knowledgeOverview.wikiPages[node.objectId]
        : undefined;
      map[node.id] = {
        compileState:
          node.objectType === "topic" && node.objectId
            ? node.compileState ?? (topicWiki ? undefined : "uncompiled")
            : undefined,
        compileStatus:
          node.objectType === "topic" && node.objectId
            ? topicWiki?.compileStatus
            : undefined,
        issueCount: issues.length,
        maxSeverity: maxIssueSeverity(issues),
      };
    }
    return map;
  }, [viewCanvas, knowledgeOverview]);
  const switchMode = (nextMode: KnowledgeCanvasProjectionMode) => {
    if (nextMode === projectionMode) return;
    setProjectionMode(nextMode);
    setSelectedChangeSetId(null);
  };
  const selectChangeSet = (changeSetId: string) => {
    setSelectedChangeSetId(changeSetId);
  };
  const openNodeDetail = async (nodeId: string) => {
    if (!canvas) return;
    setDetailNodeId(nodeId);
    setDrawer("detail");
    const detail = await window.wmb.getCanvasNodeDetail({
      canvasId: canvas.id,
      nodeId,
    });
    setNodeDetail(detail);
  };
  const closeNodeDetail = () => {
    setDetailNodeId(null);
    setNodeDetail(null);
    setDrawer((current) => (current === "detail" ? null : current));
  };
  const jumpToDetail = (target: CanvasDetailTarget) => {
    onOpenDetail?.(target);
  };
  // 节点 → 正式详情目标（深链路由由后端给出稳定正式对象 ID，这里只映射到既有导航）。
  const deepLinkTarget = (
    deepLink: KnowledgeCanvasDeepLink | null | undefined,
    detail: KnowledgeCanvasNodeDetail | null,
  ): CanvasDetailTarget | null => {
    if (!deepLink) return null;
    if (deepLink.route === "topic")
      return { type: "topic", id: deepLink.objectId, title: deepLink.title };
    if (deepLink.route === "library")
      return { type: "source", id: deepLink.objectId, title: deepLink.title };
    if (deepLink.route === "studio")
      return { type: "studio", id: deepLink.objectId, title: deepLink.title };
    if (deepLink.route === "results") return { type: "results", title: deepLink.title };
    const wiki = detail?.formal.wikiPage;
    if (wiki?.subjectType === "topic" && wiki.subjectId)
      return { type: "topic", id: wiki.subjectId, title: wiki.title };
    return null;
  };
  const selectionNodeIds = (): string[] =>
    selectedRef.current.length
      ? selectedRef.current
      : (canvas?.nodes.map((node: CanvasNodeShape) => node.id) ?? []);
  const createOrUpdateBrief = async () => {
    if (!canvas) return;
    const nodeIds = selectionNodeIds();
    if (!nodeIds.length) return;
    const structure = briefForm.structure
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!briefForm.title.trim() || !briefForm.coreJudgment.trim() || !structure.length) {
      setMessage("简报需要标题、核心判断和至少一段结构");
      return;
    }
    const base = {
      requestId: crypto.randomUUID(),
      title: briefForm.title.trim(),
      coreJudgment: briefForm.coreJudgment.trim(),
      whyNow: briefForm.whyNow.trim(),
      structure,
      evidenceNodeIds: nodeIds,
    };
    if (briefForm.existingBriefId && briefForm.expectedRevision !== undefined) {
      await window.wmb.updateCreativeBrief({
        ...base,
        id: briefForm.existingBriefId,
        expectedRevision: briefForm.expectedRevision,
      });
      setMessage("简报已更新（草稿）");
    } else {
      await window.wmb.createCreativeBrief({
        ...base,
        canvasId: canvas.id,
        nodeIds,
        selectionMode: selectionModeFor(selectedRef.current),
      });
      setMessage("简报已生成（草稿），可确认后创建内容项目");
    }
    setBriefOpen(false);
    void loadExistingBrief(nodeIds);
  };
  const loadExistingBrief = async (nodeIds: string[]) => {
    if (!canvas) return;
    const existing = await window.wmb.getCreativeBriefForContext({
      canvasId: canvas.id,
      nodeIds,
    });
    setBriefForm((current) =>
      existing
        ? {
            title: existing.title ?? current.title,
            coreJudgment: existing.coreJudgment ?? current.coreJudgment,
            whyNow: existing.whyNow ?? current.whyNow,
            structure: (existing.structure ?? []).join("\n"),
            existingBriefId: existing.id,
            expectedRevision: existing.revision,
          }
        : { ...current, existingBriefId: undefined, expectedRevision: undefined },
    );
  };
  const openBriefForm = () => {
    setBriefOpen(true);
    void loadExistingBrief(selectionNodeIds());
  };
  const confirmBriefAndCreateProject = async () => {
    if (!briefForm.existingBriefId || briefForm.expectedRevision === undefined) {
      setMessage("请先生成简报再确认并创建项目");
      return;
    }
    const updated = await window.wmb.updateCreativeBrief({
      requestId: crypto.randomUUID(),
      id: briefForm.existingBriefId,
      expectedRevision: briefForm.expectedRevision,
      title: briefForm.title,
      coreJudgment: briefForm.coreJudgment,
      whyNow: briefForm.whyNow,
      structure: briefForm.structure
        .split("\n")
        .map((item: string) => item.trim())
        .filter(Boolean),
      evidenceNodeIds: selectionNodeIds(),
      status: "confirmed",
    });
    const lineage = await window.wmb.createProjectFromBrief({
      requestId: crypto.randomUUID(),
      briefId: briefForm.existingBriefId,
      expectedRevision: updated.revision,
    });
    setBriefOpen(false);
    setMessage(`已从简报创建内容项目：${lineage.project?.title ?? "已完成"}`);
  };
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
  const { undoStack, redoStack, updateViewport, remember, undo, redo } =
    useCanvasHistory(canvas, setCanvas, loadCanvas);

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
    if (!board || !canvas) return;
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
    if ((event.target as HTMLElement).closest(".kc-port,.kc-node-check,.kc-node-detail"))
      return;
    if (!canvas) return;
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
    if (!canvas) return;
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
  const removeNode = async (node: any) => {
    if (!canvas) return;
    await window.wmb.removeKnowledgeCanvasNode({
      canvasId: canvas.id,
      nodeId: node.id,
      expectedRevision: node.revision,
    });
    setSelected((current) => current.filter((id: string) => id !== node.id));
    if (detailNodeId === node.id) closeNodeDetail();
    await loadCanvas(canvas.id);
  };
  return (
    <KnowledgeCanvasLayout
      c={{
        canvases,
        canvas: viewCanvas,
        projectionMode,
        projection,
        changeSetList,
        selectedChangeSetId,
        selectChangeSet,
        switchMode,
        nodeStatus,
        sources,
        topics,
        selected,
        box,
        connecting,
        pendingRelation,
        selectedRelation,
        drawer,
        assetQuery,
        mode,
        undoStack,
        redoStack,
        boardRef,
        manifest,
        briefOpen,
        briefForm,
        setBriefForm,
        openBriefForm,
        closeBriefForm: () => setBriefOpen(false),
        createOrUpdateBrief,
        confirmBriefAndCreateProject,
        refreshAnnounce,
        nodeDetail,
        detailNodeId,
        openNodeDetail,
        closeNodeDetail,
        deepLinkTarget,
        jumpToDetail,
        setCanvas,
        setSelected,
        setBox,
        setConnecting,
        setKeyboardConnectionSource,
        setPendingRelation,
        setSelectedRelation,
        setDrawer,
        setAssetQuery,
        setMode,
        loadCanvas,
        createCanvas,
        renameCanvas,
        updateViewport,
        undo,
        redo,
        addObject,
        addNote,
        createRelation,
        connectByKeyboard,
        saveRelation,
        hideRelation,
        archiveRelation,
        decideSuggestion,
        beginConnection,
        beginDrag,
        beginBox,
        removeNode,
        onDiscuss,
      }}
    />
  );
}
