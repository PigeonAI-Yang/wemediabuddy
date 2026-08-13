// WMB-5213：关系画布投影纯函数层（renderer 内部，无 IPC/无副作用）。
// 供 knowledge-canvas-view/layout/relations 消费；映射逻辑全部纯函数化以便局部单测
// （tests/wmb-5213-canvas-renderer.test.mjs）。
// 边界：本模块只把后端投影信封（src/shared/knowledge-canvas.ts 的结构形状）翻译成
// 展示层需要的标签/类名/命中集合；不创建第二套对象身份，不做任何写操作。

export const KNOWLEDGE_ISSUE_SEVERITY_ORDER: readonly string[] = [
  'info',
  'low',
  'medium',
  'high',
  'critical'
];

export function severityRank(severity: string | null | undefined): number {
  const index = KNOWLEDGE_ISSUE_SEVERITY_ORDER.indexOf(String(severity ?? ''));
  return index < 0 ? -1 : index;
}

const SEVERITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  info: '提示',
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重'
});

export function severityLabel(severity: string | null | undefined): string {
  return SEVERITY_LABELS[String(severity ?? '')] ?? String(severity ?? '');
}

// WMB-5233：诚实三态用户语言（uncompiled / legacy_shell / compiled）。
// legacy_shell = 历史初始化初始页（零采纳知识），空壳不得显示“已编译/当前”。
export const COMPILE_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  uncompiled: '尚未编译',
  legacy_shell: '初始档案',
  compiled: '已编译'
});

export function compileStateLabel(state: string | null | undefined): string {
  return COMPILE_STATE_LABELS[String(state ?? '')] ?? '';
}

export const CHANGE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  created: '新增',
  strengthened: '加强',
  weakened: '减弱',
  contradicted: '被反驳',
  qualified: '限定',
  superseded: '被替代',
  merged: '合并',
  promoted: '晋升',
  archived: '归档',
  rejected: '拒绝',
  restored: '恢复',
  recompiled: '重编译'
});

export function changeKindLabel(kind: string | null | undefined): string {
  return CHANGE_KIND_LABELS[String(kind ?? '')] ?? String(kind ?? '');
}

export const ISSUE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  stale_claim: '陈旧断言',
  unresolved_contradiction: '未解决矛盾',
  unsupported_claim: '无依据断言',
  duplicate_entity: '疑似重复实体',
  duplicate_knowledge: '疑似重复知识',
  orphan_knowledge: '孤立知识',
  missing_wiki_page: '缺 Wiki 页',
  stale_wiki_page: '陈旧 Wiki 页',
  broken_reference: '失效引用',
  unreturned_review: '未回流复盘',
  underperforming_method: '低绩效方法',
  overgeneralized_global: '过度泛化',
  unanswered_high_value_question: '未答高价值问题'
});

export function issueTypeLabel(issueType: string | null | undefined): string {
  return ISSUE_TYPE_LABELS[String(issueType ?? '')] ?? String(issueType ?? '');
}

export type ProjectionIssueLike = Readonly<{
  id: string;
  issueType?: string | null;
  severity?: string | null;
  status?: string | null;
  affectedObjectId?: string | null;
  affectedObjectType?: string | null;
  suggestedAction?: string | null;
  [key: string]: unknown;
}>;

export type ProjectionNodeLike = Readonly<{
  id: string;
  objectId?: string | null;
  objectType?: string | null;
  [key: string]: unknown;
}>;

/**
/** 健康问题 → 画布节点命中。身份桥只有一种：affectedObjectId。
 * 画布节点（除 note）以 business objectId 为身份；note 节点以自身 id 为身份。
 * affectedObjectType 只做提示，不作为硬条件（store 未约束枚举，WMB-5216 lint 前无生产数据）。
 */
export function issuesForNode(
  issues: readonly ProjectionIssueLike[] | null | undefined,
  node: ProjectionNodeLike | null | undefined,
): ProjectionIssueLike[] {
  if (!node || !issues?.length) return [];
  const objectId = node.objectId ?? null;
  const selfId = node.id;
  return issues.filter(
    (issue) =>
      issue.affectedObjectId != null &&
      (issue.affectedObjectId === objectId || issue.affectedObjectId === selfId),
  );
}

/** 一组健康问题的最高严重度；无问题返回 null。 */
export function maxIssueSeverity(
  issues: readonly ProjectionIssueLike[] | null | undefined,
): string | null {
  let top: string | null = null;
  for (const issue of issues ?? []) {
    const severity = String(issue.severity ?? '');
    if (severityRank(severity) > severityRank(top)) top = severity;
  }
  return top;
}

/**
 * 刷新后保留仍然存在的选中节点；消失的节点从选中清单剔除（顺序不变）。
 */
export function keepSelection(
  selected: readonly string[],
  nodes: readonly ProjectionNodeLike[] | null | undefined,
): string[] {
  const existing = new Set((nodes ?? []).map((node) => node.id));
  return selected.filter((id) => existing.has(id));
}

/** 节点投影强调类名：change 高亮与健康问题可以共存。 */
export function projectionNodeClass(node: ProjectionNodeLike | null | undefined): string {
  if (!node) return '';
  const classes: string[] = [];
  if (Array.isArray(node.changes) && node.changes.length) classes.push('changed');
  if (Array.isArray(node.healthIssueIds) && node.healthIssueIds.length) classes.push('has-issues');
  return classes.join(' ');
}

/** 选中模式：空选中 = 当前整页画布；否则 = selected_only。与 onContextChange 同规则。 */
export function selectionModeFor(selected: readonly string[]): 'current_page' | 'selected' {
  return selected.length ? 'selected' : 'current_page';
}

export type CanvasLike = {
  id: string;
  nodes: Array<{ id: string; x: number; y: number; [key: string]: unknown }>;
  [key: string]: unknown;
};

/**
 * 画布刷新的合并策略：保留用户布局（x/y），采纳新对象状态/修订。
 * 该策略保证 dataChanged 刷新不会打断正在拖拽/未提交的布局交互。
 */
export function mergeCanvasRefresh<T extends CanvasLike>(
  current: T | null | undefined,
  next: T,
): T {
  if (!current) return next;
  const layoutById = new Map(
    current.nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
  );
  return {
    ...next,
    nodes: next.nodes.map((node) => {
      const layout = layoutById.get(node.id);
      return layout ? { ...node, x: layout.x, y: layout.y } : node;
    }),
  };
}

export type ProjectionLike = Readonly<{
  mode: string;
  nodes: ReadonlyArray<
    Readonly<{
      id: string;
      changes?: readonly unknown[];
      healthIssueIds?: readonly string[];
      deepLink?: unknown;
      [key: string]: unknown;
    }>
  >;
  [key: string]: unknown;
}>;

/**
 * 把投影强调层（changes / healthIssueIds / deepLink）合并进布局画布。
 * 三模式投影与布局画布是同一对象身份：本函数只做按 id 的强调层叠加，
 * 不改变 x/y/revision 等布局字段（投影不覆盖布局）。
 */
export function mergeProjectionEmphasis(
  canvas: CanvasLike | null | undefined,
  projection: ProjectionLike | null | undefined,
): CanvasLike | null {
  if (!canvas) return null;
  if (!projection) return canvas;
  const emphasisById = new Map(
    projection.nodes.map((node) => [
      node.id,
      {
        changes: node.changes,
        healthIssueIds: node.healthIssueIds,
        deepLink: node.deepLink,
        compileState: node.compileState,
      },
    ]),
  );
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => ({
      ...node,
      ...emphasisById.get(node.id),
    })),
  };
}

/** dataChanged 触发画布刷新的 scope 集合（与 ImplementCanvasProjection 广播约定一致）。 */
export const CANVAS_REFRESH_SCOPES: readonly string[] = [
  'canvas',
  'knowledge',
  'topics',
  'health',
  'receipt',
  'library',
  'sources'
];

export function shouldRefreshCanvas(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes) return true;
  return CANVAS_REFRESH_SCOPES.some((scope) => scopes.includes(scope));
}
