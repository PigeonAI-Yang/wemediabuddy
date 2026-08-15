// WMB-5243：全局 Wiki 知识网络只读投影公共契约（Backend ↔ preload/renderer）。
// 主进程实现真源 src/main/knowledge-canvas.ts；本文件只定义通道名、稳定节点 ID 约定与纯 JSON 边界类型。
// 约束：
// - SQLite 唯一真源：只读投影复用既有正式表（topics / knowledge_notes / knowledge_entities /
//   knowledge_note_versions / knowledge_wiki_pages / knowledge_formal_relations + registry /
//   knowledge_evidence_links），不造第二套 store/schema，不新增顶级路由；
// - 稳定节点 ID = `<objectType>:<objectId>` 复合正式身份（topic:xxx / knowledge_note:xxx /
//   knowledge_entity:xxx），全软件唯一且跨投影稳定；选择清单（canvasId='global'）与深链都使用该 ID；
// - 连线 = 合并可见关系集合：正式知识关系（knowledge_formal_relations 活动行；
//   knowledge_note_version 端点解析到其笔记）+ WMB-5255 当前版本派生采纳边
//   （active 笔记 current_version 的 adoptedTopicIds/adoptedEntityIds → note -> 主题/实体
//   about 边，稳定确定性 ID `derived:about:<noteId>:<destType>:<destId>`；与正式关系
//   同 from/to/relationType 时正式优先去重），两端必须映射到可见节点；
//   Source 不作为全局常驻节点，证据只在知识卡片摘要展示；
// - 旧画布 IPC（create/get/update canvas 等）保留仅供兼容已有数据（主题页/MCP 仍依赖），新 UI 不消费。

export const KNOWLEDGE_NETWORK_PROJECTION_IPC_CHANNEL = 'knowledge-network:projection' as const;

export const KNOWLEDGE_NETWORK_NODE_DETAIL_IPC_CHANNEL = 'knowledge-network:node-detail' as const;

/**
 * 全局知识网络在 Pi 上下文选择中的画布占位 ID。
 * 新 UI 以 {canvasId: 'global', nodeIds: 稳定网络节点 ID} 调用既有
 * previewKnowledgeContextPackage / validateKnowledgeSelectionManifest 通道（PiDock 不变），
 * main 侧按该哨兵路由到全局网络冻结选择包；旧画布 UUID 永不等于该值。
 */
export const KNOWLEDGE_NETWORK_CANVAS_ID = 'global' as const;

export type KnowledgeNetworkNodeType = 'topic' | 'knowledge_note' | 'knowledge_entity';

/** 默认节点类型（全局网络常驻三类；Source 不常驻）。 */
export const KNOWLEDGE_NETWORK_DEFAULT_NODE_TYPES: readonly KnowledgeNetworkNodeType[] = Object.freeze(['topic', 'knowledge_note', 'knowledge_entity']);

/** 全局网络投影分页合同：默认页大小 500；节点上限 2000（≤上限时关系为集合级，跨页不丢失）。 */
export const KNOWLEDGE_NETWORK_DEFAULT_LIMIT = 500 as const;
export const KNOWLEDGE_NETWORK_MAX_LIMIT = 2000 as const;

/** 节点类型中文标签（filter UI / 空态文案共用）。 */
export const KNOWLEDGE_NETWORK_NODE_TYPE_LABELS: Readonly<Record<KnowledgeNetworkNodeType, string>> = Object.freeze({
  topic: '主题',
  knowledge_note: '知识结论',
  knowledge_entity: '实体'
});

/** 稳定节点 ID：`<objectType>:<objectId>`（全软件唯一正式身份；无画布手工 ID）。 */
export function knowledgeNetworkNodeId(objectType: KnowledgeNetworkNodeType, objectId: string): string {
  return `${objectType}:${objectId}`;
}

/** 解析稳定节点 ID；非法/未知类型返回 null（选择清单按此拒绝越界节点）。 */
export function parseKnowledgeNetworkNodeId(nodeId: string): { objectType: KnowledgeNetworkNodeType; objectId: string } | null {
  const index = nodeId.indexOf(':');
  if (index <= 0) return null;
  const objectType = nodeId.slice(0, index);
  if (objectType !== 'topic' && objectType !== 'knowledge_note' && objectType !== 'knowledge_entity') return null;
  const objectId = nodeId.slice(index + 1);
  if (!objectId) return null;
  return { objectType, objectId };
}

export type KnowledgeNetworkProjectionInput = Readonly<{
  limit?: number;
  offset?: number;
  /** 只投影指定节点类型（缺省三类全部）。 */
  nodeTypes?: readonly KnowledgeNetworkNodeType[];
  /** 只投影包含任一指定语义的关系（缺省全部活动关系；filters 始终展示全图可选分组）。 */
  relationKeys?: readonly string[];
}>;

/** 全局网络节点（正式对象只读投影；无 x/y —— 位置由渲染端力导向布局计算，不落第二真源）。 */
export type KnowledgeNetworkNode = Readonly<{
  /** 稳定节点 ID：`<objectType>:<objectId>`（选择清单/深链回传同一身份）。 */
  id: string;
  objectType: KnowledgeNetworkNodeType;
  /** 正式对象稳定 ID（topics.id / knowledge_notes.id / knowledge_entities.id）。 */
  objectId: string;
  /** 短标题：topics.title / knowledge_notes.title（AI 持续维护的稳定短标题）/ knowledge_entities.canonical_name。 */
  shortTitle: string;
  /** 知识摘要：topics.summary / note 当前版本 statement / entity 无正式摘要字段 → ''（诚实，不造工程元数据）。 */
  summary: string;
  /** 位置权重 = 合并可见关系度数（正式关系 + 当前版本派生采纳边；稳定；供力导向布局参考）。 */
  weight: number;
  /** 最近更新时间（正式对象 updated_at）。 */
  updatedAt: string;
}>;

/** 全局网络关系（正式知识关系活动行 + 当前版本派生采纳 about 边；两端均映射到可见节点）。 */
export type KnowledgeNetworkRelation = Readonly<{
  /** 正式关系 ID（knowledge_formal_relations.id）；派生采纳边为稳定确定性 ID `derived:about:<noteId>:<destType>:<destId>`。 */
  id: string;
  /** 起端稳定节点 ID。 */
  from: string;
  /** 终端稳定节点 ID。 */
  to: string;
  /** 语义类型（registry relation_key：supports / contradicts / qualifies / derived_from / about / ...）。 */
  relationType: string;
  /** 语义中文名（registry display_name）。 */
  displayName: string;
}>;

/** filter 分组项（投影页与全图均可消费；label 供 UI 直接显示）。 */
export type KnowledgeNetworkFilterEntry = Readonly<{
  id: string;
  label: string;
  count: number;
}>;

export type KnowledgeNetworkProjection = Readonly<{
  networkId: 'global';
  nodes: readonly KnowledgeNetworkNode[];
  /** 集合级合并关系（正式 + 当前版本派生采纳边去重后）：两端均在投影节点集合（≤ KNOWLEDGE_NETWORK_MAX_LIMIT）内；分页每页返回同一集合关系，跨页不丢失（渲染合并按 id 去重）。 */
  relations: readonly KnowledgeNetworkRelation[];
  filters: Readonly<{
    /** 可用节点类型及计数（全图口径，不受本页 limit/offset 影响）。 */
    nodeTypes: readonly KnowledgeNetworkFilterEntry[];
    /** 可用关系语义分组及计数（全图口径，不受本页 limit/offset 影响）。 */
    relationTypes: readonly KnowledgeNetworkFilterEntry[];
  }>;
  /** 匹配输入过滤的全图节点总数（含本页）。 */
  totalNodes: number;
  /** 匹配输入过滤的全图关系总数（含本页；两端均为网络节点）。 */
  totalRelations: number;
  limit: number;
  offset: number;
  /** true 表示按当前排序还有更多节点可加载（hasMore 只指节点；relations 为集合级，不随节点页变化）。 */
  hasMore: boolean;
  updatedAt: string;
}>;

export type KnowledgeNetworkNodeDetailInput = Readonly<{ nodeId: string }>;

/** 依据摘要条目（证据边界摘要；不注入全部 Source 原文）。 */
export type KnowledgeNetworkEvidenceEntry = Readonly<{
  relation: string;
  sourceNature: string;
  excerpt: string | null;
  locator: string | null;
  /** 证据对象标题（source → source_items.title；其余对象类型诚实为 null）。 */
  sourceTitle: string | null;
}>;

/** 相关认识条目（相关笔记/实体；nodeId 为稳定节点 ID，可直接二次打开详情）。 */
export type KnowledgeNetworkRelatedEntry = Readonly<{
  nodeId: string;
  objectType: KnowledgeNetworkNodeType;
  objectId: string;
  title: string;
  /** 相关语义（formal relation key；adopted 语义用 registry 的 about）。 */
  relationKey: string;
}>;

/** 固定版本引用（冻结：知识正文来自该版本；无正式版本时 null）。 */
export type KnowledgeNetworkVersionRef = Readonly<{
  versionKind: 'note_version' | 'wiki_page_version';
  versionId: string;
  objectType: KnowledgeNetworkNodeType;
  objectId: string;
  createdAt: string;
}>;

/** 节点知识本体详情（知识卡片第一屏字段；对象 ID/表名/ChangeSet/编译状态不进入第一屏）。 */
export type KnowledgeNetworkNodeDetail = Readonly<{
  node: KnowledgeNetworkNode;
  knowledge: Readonly<{
    /** 完整认识：topic 当前综合（topics.summary）/ note 当前版本 statement / entity 核心说明（诚实回退 canonical_name）。 */
    primary: string;
    /** 适用范围：note 当前版本 applies_to；topic/entity 无正式适用范围字段 → ''（诚实）。 */
    scope: string;
    /** 证据边界：版本证据链接计数 + 关系/来源性质分布（有界）。 */
    evidenceBoundary: Readonly<{
      evidenceCount: number;
      byRelation: Readonly<Record<string, number>>;
      bySourceNature: Readonly<Record<string, number>>;
    }>;
    /** 依据摘要：证据链接有界列表（有界 10 条）。 */
    evidenceSummary: readonly KnowledgeNetworkEvidenceEntry[];
    /** 相关认识：相关笔记/实体短标题有界列表（有界 10 条）。 */
    related: readonly KnowledgeNetworkRelatedEntry[];
    /** 最近更新时间。 */
    updatedAt: string;
  }>;
  versionRef: KnowledgeNetworkVersionRef | null;
  deepLink: Readonly<{
    route: 'topic' | 'object';
    objectType: string;
    objectId: string;
    title: string;
  }> | null;
}>;
