// WMB-5213 M4：关系画布三模式投影公共契约（Canvas backend ↔ preload/renderer）。
// 主进程实现真源 src/main/knowledge-canvas.ts；本文件只定义通道名与纯 JSON 边界类型。
// 约束：
// - 不暴露内部 DB 或任意 SQL；投影只读，复用 v56 读模型与既有画布表，不造第二套 store/schema；
// - 三模式投影同一对象身份：nodes 数组在 relation/change/health 间完全一致（同一 canvas node id
//   + 同一正式对象 id），模式只是强调层（node.changes / node.healthIssueIds + modeData）；
// - 深链必须是既有正式对象稳定 ID（topics.id / source_items.id / knowledge_* 对象 id），
//   路由名由 renderer 映射到既有导航（openTopic / libraryFocusSourceId / openStudio 等）。

import type {
  KnowledgeChangeSetRecord,
  KnowledgeChangeType,
  KnowledgeEntityRecord,
  KnowledgeHealthIssueRecord,
  KnowledgeNoteRecord,
  KnowledgeUpdateReceiptRecord,
  KnowledgeWikiPageRecord,
  KnowledgeWikiPageVersionRecord
} from './knowledge-flywheel.ts';
// WMB-5233：诚实三态（uncompiled / legacy_shell / compiled），空壳不显示已编译。
import type { KnowledgeCompileState } from './knowledge-compile-state.ts';

/** 画布三模式投影读通道。 */
export const KNOWLEDGE_CANVAS_PROJECTION_IPC_CHANNEL = 'knowledge-canvas:projection' as const;

/** 画布节点正式对象详情（深链数据）读通道。 */
export const KNOWLEDGE_CANVAS_DETAIL_IPC_CHANNEL = 'knowledge-canvas:detail' as const;

/** selected-only 创作动作的规范输入清单校验通道（UI 展示与正式写使用同一份）。 */
export const KNOWLEDGE_CANVAS_SELECTION_MANIFEST_IPC_CHANNEL = 'knowledge-context:selection-manifest' as const;

export type KnowledgeCanvasProjectionMode = 'relation' | 'change' | 'health';

export type KnowledgeCanvasProjectionInput = Readonly<{
  canvasId: string;
  mode: KnowledgeCanvasProjectionMode;
  /** change 模式：指定 ChangeSet（须属于当前工作空间）；缺省 = 最近一次 ChangeSet。 */
  changeSetId?: string;
  /** health 模式：true 时包含 resolved/accepted_risk/false_positive；缺省只投影未解决（open/repairing）。 */
  includeResolvedIssues?: boolean;
  limit?: number;
  offset?: number;
}>;

/** 节点 → 正式对象深链目标（既有稳定 ID；formal* 为该对象的 v56 正式知识身份）。 */
export type KnowledgeCanvasDeepLink = Readonly<{
  route: 'topic' | 'library' | 'studio' | 'results' | 'object';
  objectType: string;
  objectId: string;
  title: string;
  formalObjectType: 'wiki_page' | 'knowledge_note' | 'knowledge_entity' | 'free_note' | null;
  formalObjectId: string | null;
}>;

/** change 模式：一个正式对象在一次 ChangeSet 中的变化（按正式对象去重）。 */
export type KnowledgeCanvasNodeChange = Readonly<{
  changeSetId: string;
  changeType: KnowledgeChangeType | 'relation_created' | 'relation_ended' | 'health_resolved' | 'topic_updated';
  objectType: string;
  objectId: string;
  summary: string;
}>;

export type KnowledgeCanvasProjectedNode = Readonly<{
  id: string;
  objectType: string;
  objectId: string | null;
  noteTitle: string | null;
  noteText: string | null;
  x: number;
  y: number;
  zIndex: number;
  revision: number;
  /** 与 getKnowledgeCanvas 一致的引用解析（{id,title,body,revision}；note 节点为本地对象）。 */
  object: Readonly<Record<string, unknown>> | null;
  deepLink: KnowledgeCanvasDeepLink | null;
  /** WMB-5233：topic 节点诚实三态（uncompiled / legacy_shell / compiled）；非 topic 节点不设置。 */
  compileState?: KnowledgeCompileState;
  /** change 模式：该节点受目标 ChangeSet 影响的正式对象变化。 */
  changes?: readonly KnowledgeCanvasNodeChange[];
  /** health 模式：该节点关联的健康问题 ID（与 modeData.healthIssues 同一 ID 空间）。 */
  healthIssueIds?: readonly string[];
}>;

/** 画布可视化关系（v18/v21 knowledge_relations；非正式知识关系，三模式原样投影）。 */
export type KnowledgeCanvasProjectedRelation = Readonly<{
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  label: string | null;
  state: string;
  hidden: number;
  createdBy: string;
  revision: number;
}>;

/** health 模式：健康问题投影行（affectedObjectId 与资料库/主题使用的正式对象 ID 完全一致）。 */
export type KnowledgeCanvasHealthIssueProjection = KnowledgeHealthIssueRecord & Readonly<{
  /** 命中画布节点 id；未命中画布节点的画布级问题为 null。 */
  matchedNodeId: string | null;
}>;

export type KnowledgeCanvasProjection = Readonly<{
  mode: KnowledgeCanvasProjectionMode;
  canvasId: string;
  canvas: Readonly<{
    id: string;
    title: string;
    topicId: string | null;
    viewportX: number;
    viewportY: number;
    zoom: number;
    revision: number;
    updatedAt: string;
  }>;
  /** 三模式同一对象身份：nodes 恒为同一数组语义（模式强调层在 node 上）。 */
  nodes: readonly KnowledgeCanvasProjectedNode[];
  relations: readonly KnowledgeCanvasProjectedRelation[];
  suggestions: readonly Readonly<Record<string, unknown>>[];
  modeData: Readonly<{
    /** change 模式：目标 ChangeSet 与对应回执（无则 null）。 */
    changeSet: KnowledgeChangeSetRecord | null;
    receipt: KnowledgeUpdateReceiptRecord | null;
    /** health 模式：有界问题投影页（relation/change 模式为 null）。 */
    healthIssues: readonly KnowledgeCanvasHealthIssueProjection[] | null;
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
  updatedAt: string;
}>;

export type KnowledgeCanvasNodeDetailInput = Readonly<{ canvasId: string; nodeId: string }>;

/** 节点详情深链数据：正式对象（wiki 当前页/笔记/实体）+ 健康问题 + 最近变化。 */
export type KnowledgeCanvasNodeDetail = Readonly<{
  node: KnowledgeCanvasProjectedNode;
  formal: Readonly<{
    wikiPage: KnowledgeWikiPageRecord | null;
    wikiPageVersion: KnowledgeWikiPageVersionRecord | null;
    notes: readonly KnowledgeNoteRecord[];
    entities: readonly KnowledgeEntityRecord[];
    healthIssues: readonly KnowledgeHealthIssueRecord[];
    recentChanges: readonly KnowledgeChangeSetRecord[];
    /** WMB-5233：诚实三态（uncompiled / legacy_shell / compiled）；空壳不显示已编译。 */
    compileState: KnowledgeCompileState;
  }>;
}>;

export type KnowledgeCanvasSelectionManifestInput = Readonly<{ canvasId: string; nodeIds: string[] }>;

export type KnowledgeCanvasSelectionManifestItem = Readonly<{
  nodeId: string;
  objectType: string;
  objectId: string | null;
  title: string;
  snapshot: Readonly<Record<string, unknown>> | null;
}>;

/**
 * selected-only 创作动作的规范输入清单：UI 展示的清单与正式写使用的清单必须是同一份
 * （不允许 UI 显示选中 A、服务端实际使用全画布）。越界/重复节点由 main 拒绝。
 */
export type KnowledgeCanvasSelectionManifest = Readonly<{
  scope: 'selected_only';
  canvasId: string;
  items: readonly KnowledgeCanvasSelectionManifestItem[];
  estimatedCharacters: number;
  limitCharacters: number;
  overLimit: boolean;
}>;
