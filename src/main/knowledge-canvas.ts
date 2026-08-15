import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContentProjectWithVersion, getContentProject } from './content.ts';
// WMB-5213：三模式投影复用 v56 读 API（getChangeSet / getUpdateReceiptByRequest / listChangeSets /
// listHealthIssues / getWikiPage）与 v56 表（只读 join，不造第二套 store/schema）。
import {
  getChangeSet, getWikiPage, listChangeSets
} from './knowledge-flywheel.ts';
// WMB-5233：诚实三态（与 Topic/Library 投影同一判定；空壳不显示已编译）。
import { classifyWikiCompileState } from './knowledge-compile-state.ts';
import type {
  KnowledgeCanvasDeepLink, KnowledgeCanvasNodeChange, KnowledgeCanvasProjectedNode, KnowledgeCanvasProjectedRelation,
  KnowledgeCanvasProjection, KnowledgeCanvasProjectionInput, KnowledgeCanvasNodeDetail, KnowledgeCanvasNodeDetailInput,
  KnowledgeCanvasSelectionManifest, KnowledgeCanvasSelectionManifestInput, KnowledgeCanvasHealthIssueProjection
} from '../shared/knowledge-canvas.ts';
// WMB-5243：全局 Wiki 知识网络只读投影（无 canvasId；稳定节点 ID = `<objectType>:<objectId>`）。
import {
  KNOWLEDGE_NETWORK_CANVAS_ID,
  KNOWLEDGE_NETWORK_DEFAULT_LIMIT,
  KNOWLEDGE_NETWORK_DEFAULT_NODE_TYPES,
  KNOWLEDGE_NETWORK_MAX_LIMIT,
  KNOWLEDGE_NETWORK_NODE_TYPE_LABELS,
  knowledgeNetworkNodeId,
  parseKnowledgeNetworkNodeId,
  type KnowledgeNetworkEvidenceEntry,
  type KnowledgeNetworkNode,
  type KnowledgeNetworkNodeDetail,
  type KnowledgeNetworkNodeDetailInput,
  type KnowledgeNetworkNodeType,
  type KnowledgeNetworkProjection,
  type KnowledgeNetworkProjectionInput,
  type KnowledgeNetworkRelatedEntry,
  type KnowledgeNetworkVersionRef
} from '../shared/knowledge-network.ts';
import type {
  KnowledgeChangeSetRecord, KnowledgeEntityRecord, KnowledgeHealthIssueRecord, KnowledgeNoteRecord,
  KnowledgeUpdateReceiptRecord as SharedKnowledgeUpdateReceiptRecord, KnowledgeWikiPageRecord, KnowledgeWikiPageVersionRecord
} from '../shared/knowledge-flywheel.ts';
import type { KnowledgeCompileState } from '../shared/knowledge-compile-state.ts';
// 回执来自主进程 store 的读 API，其记录类型（affectedTopics 等）以 store 为准。
import type { KnowledgeUpdateReceiptRecord } from './knowledge-flywheel.ts';

const objectTables = {
  topic: ['topics', 'title', 'summary', 'revision'],
  source: ['source_items', 'title', 'summary', 'revision'],
  plan_item: ['plan_items', 'title', 'point_of_view', 'revision'],
  content_project: ['content_projects', 'title', "(SELECT body FROM content_versions WHERE project_id=content_projects.id ORDER BY version_number DESC LIMIT 1)", 'revision'],
  publication: ['publications', "platform || ' 发布'", 'external_url', 'revision'],
  metric_snapshot: ['publication_metric_snapshots', 'scheduled_for', 'normalized_json', '1'],
  review: ['reviews', "'复盘 ' || substr(id,1,8)", 'summary', 'revision'],
  method_finding: ['method_findings', 'title', 'body', 'revision']
} as const;
const relationTypes = new Set(['supports', 'contradicts', 'derived_from', 'responds_to', 'uses_method', 'becomes_content', 'custom']);

type ObjectType = keyof typeof objectTables | 'note';

function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw new Error('REVISION_CONFLICT');
}

function resolveObject(database: DatabaseSync, type: ObjectType, id: string | null) {
  if (type === 'note') return null;
  const definition = objectTables[type];
  if (!definition || !id) throw new Error('INVALID_OBJECT_REFERENCE');
  const [table, titleColumn, bodyColumn, revisionColumn] = definition;
  const row = database.prepare(`SELECT id, ${titleColumn} AS title, coalesce(${bodyColumn},'') AS body, ${revisionColumn} AS revision FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('OBJECT_NOT_FOUND');
  return row;
}

export function createKnowledgeCanvas(database: DatabaseSync, input: { title: string; topicId?: string }) {
  const title = input.title.trim();
  if (!title) throw new Error('CANVAS_TITLE_REQUIRED');
  if (input.topicId) resolveObject(database, 'topic', input.topicId);
  const id = randomUUID(), now = new Date().toISOString();
  database.prepare(`INSERT INTO knowledge_canvases(id,title,topic_id,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run(id, title, input.topicId ?? null, now, now);
  return getKnowledgeCanvas(database, id);
}

export function listKnowledgeCanvases(database: DatabaseSync) {
  return database.prepare(`SELECT c.id,c.title,c.topic_id AS topicId,c.updated_at AS updatedAt,c.revision,
    count(DISTINCT n.id) AS nodeCount,count(DISTINCT r.id) AS relationCount
    FROM knowledge_canvases c LEFT JOIN knowledge_canvas_nodes n ON n.canvas_id=c.id
    LEFT JOIN knowledge_relations r ON r.canvas_id=c.id AND r.archived_at IS NULL
    WHERE c.archived_at IS NULL GROUP BY c.id ORDER BY c.updated_at DESC,c.id`).all();
}

export function updateKnowledgeCanvas(database: DatabaseSync,input:{
  id:string;expectedRevision:number;title?:string;viewportX?:number;viewportY?:number;zoom?:number;
}){
  const current=database.prepare('SELECT revision,title,viewport_x AS viewportX,viewport_y AS viewportY,zoom FROM knowledge_canvases WHERE id=? AND archived_at IS NULL').get(input.id) as any;
  if(!current)throw new Error('CANVAS_NOT_FOUND');
  assertRevision(current.revision,input.expectedRevision);
  const title=input.title===undefined?current.title:input.title.trim();
  if(!title)throw new Error('CANVAS_TITLE_REQUIRED');
  const zoom=input.zoom??current.zoom;
  if(zoom<0.5||zoom>2)throw new Error('CANVAS_ZOOM_INVALID');
  database.prepare(`UPDATE knowledge_canvases SET title=?,viewport_x=?,viewport_y=?,zoom=?,updated_at=?,revision=revision+1 WHERE id=?`)
    .run(title,input.viewportX??current.viewportX,input.viewportY??current.viewportY,zoom,new Date().toISOString(),input.id);
  return getKnowledgeCanvas(database,input.id);
}

export function getKnowledgeCanvas(database: DatabaseSync, id: string) {
  const canvas = database.prepare(`SELECT id,title,topic_id AS topicId,viewport_x AS viewportX,viewport_y AS viewportY,zoom,revision,updated_at AS updatedAt
    FROM knowledge_canvases WHERE id=? AND archived_at IS NULL`).get(id);
  if (!canvas) throw new Error('CANVAS_NOT_FOUND');
  const nodes = (database.prepare(`SELECT id,canvas_id AS canvasId,object_type AS objectType,object_id AS objectId,note_title AS noteTitle,
    note_text AS noteText,x,y,width,height,z_index AS zIndex,revision FROM knowledge_canvas_nodes WHERE canvas_id=? ORDER BY z_index,id`).all(id) as any[])
    .map((node) => ({ ...node, object: node.objectType === 'note' ? { id: node.id, title: node.noteTitle, body: node.noteText ?? '', revision: node.revision } : resolveObject(database, node.objectType, node.objectId) }));
  const relations = database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,
    label,state,hidden,created_by AS createdBy,revision FROM knowledge_relations WHERE canvas_id=? AND archived_at IS NULL ORDER BY id`).all(id);
  const suggestions=(database.prepare(`SELECT id,kind,payload_json AS payloadJson,state,created_at AS createdAt,revision
    FROM knowledge_suggestions WHERE canvas_id=? AND state='suggested' ORDER BY created_at,id`).all(id) as any[])
    .map(({payloadJson,...item})=>({...item,payload:JSON.parse(payloadJson)}));
  return { ...canvas as object, nodes, relations, suggestions };
}

// ============================================================
// WMB-5213 M4：三模式投影（relation / change / health）+ 深链 + selected-only 清单
// 只读投影；复用 v56 读 API 与既有画布表；三模式同一对象身份（同一 canvas node id + 同一正式对象 id）。
// ============================================================

/** getKnowledgeCanvas 返回行的结构投影（现有函数本身返回松散行，此处一次收紧边界）。 */
type ProjectedCanvasNodeRow = {
  id: string;
  canvasId: string;
  objectType: string;
  objectId: string | null;
  noteTitle: string | null;
  noteText: string | null;
  x: number;
  y: number;
  zIndex: number;
  revision: number;
  object: Record<string, unknown> | null;
};

type ProjectedCanvasRows = {
  id: string;
  title: string;
  topicId: string | null;
  viewportX: number;
  viewportY: number;
  zoom: number;
  revision: number;
  updatedAt: string | null;
  nodes: ProjectedCanvasNodeRow[];
  relations: Array<Record<string, unknown>>;
  suggestions: Array<Record<string, unknown>>;
};

const DEEP_LINK_ROUTES: Readonly<Record<string, 'topic' | 'library' | 'studio' | 'results' | 'object'>> = Object.freeze({
  topic: 'topic',
  source: 'library',
  content_project: 'studio',
  publication: 'results',
  review: 'results',
  plan_item: 'object',
  metric_snapshot: 'object',
  method_finding: 'object'
});

/** 画布节点 objectType → 可被 ChangeSet 证据/版本触及的 v56 evidence_object_type 集合。 */
const EVIDENCE_OBJECT_TYPES_BY_NODE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  source: ['source'],
  review: ['review'],
  publication: ['publication'],
  content_project: ['content_version', 'platform_version'],
  metric_snapshot: ['metric_snapshot'],
  method_finding: ['review']
});

function canvasSnapshot(canvas: ProjectedCanvasRows) {
  return {
    id: canvas.id, title: canvas.title, topicId: canvas.topicId ?? null, viewportX: canvas.viewportX ?? 0,
    viewportY: canvas.viewportY ?? 0, zoom: canvas.zoom ?? 1, revision: canvas.revision, updatedAt: canvas.updatedAt ?? ''
  };
}

function deepLinkForNode(database: DatabaseSync, node: ProjectedCanvasNodeRow): KnowledgeCanvasDeepLink | null {
  if (node.objectType === 'note' || !node.objectId) return null;
  const route = DEEP_LINK_ROUTES[node.objectType] ?? 'object';
  const title = typeof node.object?.title === 'string' && node.object.title ? node.object.title : (node.noteTitle ?? '');
  if (node.objectType === 'topic') {
    let formalObjectId: string | null = null;
    try {
      const page = database.prepare(`SELECT id FROM knowledge_wiki_pages
        WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' ORDER BY updated_at DESC LIMIT 1`).get(node.objectId) as { id: string } | undefined;
      formalObjectId = page?.id ?? null;
    } catch {
      formalObjectId = null; // 精简 fixture 缺 v56 表 → 无正式知识身份
    }
    return { route, objectType: node.objectType, objectId: node.objectId, title, formalObjectType: formalObjectId ? 'wiki_page' : null, formalObjectId };
  }
  return { route, objectType: node.objectType, objectId: node.objectId, title, formalObjectType: null, formalObjectId: null };
}

function projectNode(database: DatabaseSync, node: ProjectedCanvasNodeRow) {
  const projected = { ...node, deepLink: deepLinkForNode(database, node) } as Record<string, unknown>;
  // WMB-5233：topic 节点携带诚实三态（uncompiled / legacy_shell / compiled），
  // 三模式同一身份；非 topic 节点不设置（渲染端回退 compileStatus 行为）。
  if (node.objectType === 'topic' && node.objectId) {
    try {
      const page = database.prepare(`SELECT id FROM knowledge_wiki_pages
        WHERE subject_type='topic' AND subject_id=? AND lifecycle='active' ORDER BY updated_at DESC LIMIT 1`).get(node.objectId) as { id: string } | undefined;
      if (page) {
        const detail = getWikiPage(database, page.id);
        if (detail) {
          const wikiPage = detail.page as unknown as KnowledgeWikiPageRecord;
          const wikiVersion = detail.version as unknown as KnowledgeWikiPageVersionRecord | null;
          const body = wikiVersion?.body && typeof wikiVersion.body === 'object'
            ? wikiVersion.body as Readonly<Record<string, unknown>>
            : null;
          projected.compileState = classifyWikiCompileState({ page: wikiPage, current: wikiVersion, body });
        }
      }
      if (projected.compileState === undefined) projected.compileState = 'uncompiled' as const;
    } catch {
      projected.compileState = 'uncompiled' as const; // 精简 fixture 缺 v56 表 → 无正式编译
    }
  }
  return projected as ProjectedCanvasNodeRow & { deepLink: KnowledgeCanvasDeepLink | null; compileState?: KnowledgeCompileState };
}

/** health 行 → 投影记录（evidence 解析为对象；SQL 行一次收紧为共享契约类型）。 */
function mapHealthIssueProjectionRow(row: Record<string, unknown>): KnowledgeCanvasHealthIssueProjection {
  return {
    id: String(row.id), scope: row.scope as KnowledgeCanvasHealthIssueProjection['scope'],
    issueType: row.issueType as KnowledgeCanvasHealthIssueProjection['issueType'],
    affectedObjectType: (row.affectedObjectType as string | null) ?? null,
    affectedObjectId: (row.affectedObjectId as string | null) ?? null,
    severity: row.severity as KnowledgeCanvasHealthIssueProjection['severity'],
    evidence: JSON.parse(String(row.evidenceJson)) as Record<string, unknown>,
    suggestedAction: String(row.suggestedAction ?? ''),
    status: row.status as KnowledgeCanvasHealthIssueProjection['status'],
    resolutionNote: (row.resolutionNote as string | null) ?? null,
    resolvedChangeSetId: (row.resolvedChangeSetId as string | null) ?? null,
    detectedAt: String(row.detectedAt), updatedAt: String(row.updatedAt),
    resolvedAt: (row.resolvedAt as string | null) ?? null, revision: Number(row.revision),
    matchedNodeId: null
  };
}

/** health 模式：有界问题投影页（affectedObjectId 与资料库/主题使用同一正式对象 ID）。 */
function listCanvasHealthIssues(database: DatabaseSync, input: { includeResolved?: boolean; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const statusClause = input.includeResolved ? '' : "WHERE status IN ('open','repairing')";
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_health_issues ${statusClause}`).get() as { count: number }).count);
  const items = (database.prepare(`SELECT id, scope, issue_type AS issueType, affected_object_type AS affectedObjectType,
    affected_object_id AS affectedObjectId, severity, evidence_json AS evidenceJson, suggested_action AS suggestedAction, status,
    resolution_note AS resolutionNote, resolved_change_set_id AS resolvedChangeSetId, detected_at AS detectedAt,
    updated_at AS updatedAt, resolved_at AS resolvedAt, revision
    FROM knowledge_health_issues ${statusClause} ORDER BY detected_at DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[])
    .map(mapHealthIssueProjectionRow);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

type AffectedChangeSetObjects = {
  /** note_id → {changeType, title} */
  noteChanges: Map<string, { changeType: string; title: string }>;
  /** page_id → {title, summary, subjectType, subjectId} */
  pageChanges: Map<string, { title: string; summary: string; subjectType: string | null; subjectId: string | null }>;
  /** topic_id → 变化描述数组（note 版本 adopted_topic_ids / wiki 页 subject / 回执 affectedTopics） */
  topicChanges: Map<string, Array<{ changeType: string; title: string }>>;
  /** evidence_object_type → (evidence_object_id → Set<relation>) */
  evidenceByType: Map<string, Map<string, Set<string>>>;
  relationIds: Set<string>;
  endedRelationIds: Set<string>;
  resolvedHealthIds: Set<string>;
  entityIds: Set<string>;
};

function collectChangeSetAffectedObjects(database: DatabaseSync, changeSetId: string, receipt: KnowledgeUpdateReceiptRecord | null): AffectedChangeSetObjects {
  const noteChanges = new Map<string, { changeType: string; title: string }>();
  const pageChanges = new Map<string, { title: string; summary: string; subjectType: string | null; subjectId: string | null }>();
  const topicChanges = new Map<string, Array<{ changeType: string; title: string }>>();
  const evidenceByType = new Map<string, Map<string, Set<string>>>();
  const relationIds = new Set<string>();
  const endedRelationIds = new Set<string>();
  const resolvedHealthIds = new Set<string>();
  const entityIds = new Set<string>();

  try {
    for (const row of database.prepare(`SELECT v.note_id AS noteId, v.change_type AS changeType, n.title
      FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id WHERE v.change_set_id = ?`).all(changeSetId) as Record<string, unknown>[]) {
      noteChanges.set(String(row.noteId), { changeType: String(row.changeType), title: String(row.title ?? '') });
    }
    for (const row of database.prepare(`SELECT v.note_id AS noteId, v.change_type AS changeType, n.title,
      j.value AS topicId FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id,
      json_each(v.adopted_topic_ids_json) j WHERE v.change_set_id = ?`).all(changeSetId) as Record<string, unknown>[]) {
      const topicId = String(row.topicId);
      const list = topicChanges.get(topicId) ?? [];
      list.push({ changeType: String(row.changeType), title: String(row.title ?? '') });
      topicChanges.set(topicId, list);
    }
    for (const row of database.prepare(`SELECT v.page_id AS pageId, v.title, v.change_summary AS changeSummary,
      p.subject_type AS subjectType, p.subject_id AS subjectId FROM knowledge_wiki_page_versions v
      JOIN knowledge_wiki_pages p ON p.id = v.page_id WHERE v.change_set_id = ?`).all(changeSetId) as Record<string, unknown>[]) {
      pageChanges.set(String(row.pageId), { title: String(row.title ?? ''), summary: String(row.changeSummary ?? ''), subjectType: row.subjectType ? String(row.subjectType) : null, subjectId: row.subjectId ? String(row.subjectId) : null });
      if (row.subjectType === 'topic' && row.subjectId) {
        const topicId = String(row.subjectId);
        const list = topicChanges.get(topicId) ?? [];
        list.push({ changeType: 'recompiled', title: String(row.title ?? '') });
        topicChanges.set(topicId, list);
      }
    }
    for (const row of database.prepare(`SELECT id, relation_key AS relationKey, from_object_type AS fromObjectType,
      from_object_id AS fromObjectId, to_object_type AS toObjectType, to_object_id AS toObjectId,
      ended_change_set_id AS endedChangeSetId FROM knowledge_formal_relations
      WHERE created_change_set_id = ? OR ended_change_set_id = ?`).all(changeSetId, changeSetId) as Record<string, unknown>[]) {
      relationIds.add(String(row.id));
      if (row.endedChangeSetId) endedRelationIds.add(String(row.id));
    }
    for (const row of database.prepare(`SELECT evidence_object_type AS objectType, evidence_object_id AS objectId, relation
      FROM knowledge_evidence_links WHERE change_set_id = ?`).all(changeSetId) as Record<string, unknown>[]) {
      let byId = evidenceByType.get(String(row.objectType));
      if (!byId) { byId = new Map(); evidenceByType.set(String(row.objectType), byId); }
      let relations = byId.get(String(row.objectId));
      if (!relations) { relations = new Set(); byId.set(String(row.objectId), relations); }
      relations.add(String(row.relation));
    }
    for (const row of database.prepare('SELECT id FROM knowledge_health_issues WHERE resolved_change_set_id = ?').all(changeSetId) as Record<string, unknown>[]) {
      resolvedHealthIds.add(String(row.id));
    }
  } catch {
    // 精简 fixture 缺 v56 表 → 派生集合为空（健康/变化模式仅回执级信息）
  }
  for (const entry of receipt?.affectedTopics ?? []) {
    const topicId = typeof entry === 'string' ? entry : null;
    if (topicId && !topicChanges.has(topicId)) topicChanges.set(topicId, []);
  }
  for (const entry of receipt?.affectedEntities ?? []) {
    const entityId = typeof entry === 'string' ? entry : null;
    if (entityId) entityIds.add(entityId);
  }
  return { noteChanges, pageChanges, topicChanges, evidenceByType, relationIds, endedRelationIds, resolvedHealthIds, entityIds };
}

function evidenceChangeType(relation: string): string {
  if (relation === 'supports') return 'strengthened';
  if (relation === 'contradicts') return 'contradicted';
  if (relation === 'qualifies') return 'qualified';
  return 'created';
}

function changesForNode(database: DatabaseSync, node: ProjectedCanvasNodeRow, changeSetId: string, affected: AffectedChangeSetObjects): KnowledgeCanvasNodeChange[] {
  const changes: KnowledgeCanvasNodeChange[] = [];
  if (!node.objectId) return changes;
  if (node.objectType === 'topic') {
    const entries = affected.topicChanges.get(node.objectId);
    if (entries !== undefined) {
      const primary = entries[0];
      const summary = entries.length
        ? `知识变化：${entries.slice(0, 2).map((entry) => (entry.title ? `${entry.changeType}「${entry.title}」` : entry.changeType)).join('；')}`
        : '主题知识更新';
      changes.push({ changeSetId, changeType: (primary?.changeType ?? 'topic_updated') as KnowledgeCanvasNodeChange['changeType'], objectType: 'topic', objectId: node.objectId, summary });
    }
  } else if (node.objectType === 'knowledge_note') {
    const entry = affected.noteChanges.get(node.objectId);
    if (entry) changes.push({ changeSetId, changeType: entry.changeType as KnowledgeCanvasNodeChange['changeType'], objectType: 'knowledge_note', objectId: node.objectId, summary: `笔记更新：${entry.title}` });
  } else if (node.objectType === 'wiki_page') {
    const entry = affected.pageChanges.get(node.objectId);
    if (entry) changes.push({ changeSetId, changeType: 'recompiled', objectType: 'wiki_page', objectId: node.objectId, summary: entry.summary || `页面更新：${entry.title}` });
  } else {
    const evidenceTypes = EVIDENCE_OBJECT_TYPES_BY_NODE[node.objectType] ?? [];
    for (const evidenceType of evidenceTypes) {
      const relations = affected.evidenceByType.get(evidenceType)?.get(node.objectId);
      if (relations && relations.size) {
        const primary = [...relations][0] ?? 'supports';
        changes.push({ changeSetId, changeType: evidenceChangeType(primary) as KnowledgeCanvasNodeChange['changeType'], objectType: node.objectType, objectId: node.objectId, summary: `证据：${evidenceType} 关系 ${[...relations].join('、')}` });
      }
    }
  }
  return changes;
}

/** 回执 ↔ ChangeSet 直接关联（v56 表只读；store 未导出该查询，此处同读模型投影）。 */
function getReceiptByChangeSet(database: DatabaseSync, changeSetId: string): KnowledgeUpdateReceiptRecord | null {
  try {
    const row = database.prepare(`SELECT id, workspace_id AS workspaceId, change_set_id AS changeSetId, trigger_type AS triggerType,
      request_id AS requestId, summary, counts_json AS countsJson, affected_topics_json AS affectedTopics,
      affected_entities_json AS affectedEntities, affected_methods_json AS affectedMethods, affected_syntheses_json AS affectedSyntheses,
      wiki_page_versions_json AS wikiPageVersions, impact_json AS impactJson, auto_resolutions_json AS autoResolutions,
      retained_disputes_json AS retainedDisputes, failures_json AS failures, created_by AS createdBy, created_at AS createdAt
      FROM knowledge_update_receipts WHERE change_set_id = ? LIMIT 1`).get(changeSetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), workspaceId: String(row.workspaceId), changeSetId: String(row.changeSetId),
      triggerType: row.triggerType as KnowledgeUpdateReceiptRecord['triggerType'], requestId: String(row.requestId), summary: String(row.summary),
      counts: JSON.parse(String(row.countsJson)) as Readonly<Record<string, number>>,
      affectedTopics: JSON.parse(String(row.affectedTopics)) as string[],
      affectedEntities: JSON.parse(String(row.affectedEntities)) as string[],
      affectedMethods: JSON.parse(String(row.affectedMethods)) as string[],
      affectedSyntheses: JSON.parse(String(row.affectedSyntheses)) as string[],
      wikiPageVersions: JSON.parse(String(row.wikiPageVersions)) as string[],
      impact: JSON.parse(String(row.impactJson)) as Readonly<Record<string, unknown>>,
      autoResolutions: JSON.parse(String(row.autoResolutions)) as string[],
      retainedDisputes: JSON.parse(String(row.retainedDisputes)) as string[],
      failures: JSON.parse(String(row.failures)) as string[],
      createdBy: row.createdBy as KnowledgeUpdateReceiptRecord['createdBy'], createdAt: String(row.createdAt)
    };
  } catch {
    return null; // 精简 fixture 缺 v56 表
  }
}

function buildChangeProjection(database: DatabaseSync, canvas: ProjectedCanvasRows, changeSetId: string | undefined): { nodes: KnowledgeCanvasProjectedNode[]; modeData: KnowledgeCanvasProjection['modeData'] } {
  const changeSet = changeSetId === undefined ? (listChangeSets(database, { limit: 1 }).items[0] ?? null) : getChangeSet(database, changeSetId);
  if (changeSetId !== undefined && !changeSet) throw new Error('CHANGE_SET_NOT_FOUND');
  let nodes: KnowledgeCanvasProjectedNode[] = [];
  const receipt = changeSet ? getReceiptByChangeSet(database, changeSet.id) : null;
  if (changeSet) {
    const affected = collectChangeSetAffectedObjects(database, changeSet.id, receipt);
    nodes = canvas.nodes.map((node) => ({ ...projectNode(database, node), changes: changesForNode(database, node, changeSet.id, affected) }));
  } else {
    nodes = canvas.nodes.map((node) => projectNode(database, node));
  }
  return {
    nodes,
    modeData: {
      changeSet,
      // store 回执记录与共享契约字段一致（affectedTopics 为 string[]），此处收紧为边界类型。
      receipt: receipt as unknown as SharedKnowledgeUpdateReceiptRecord,
      healthIssues: null,
      total: changeSet ? 1 : 0, limit: 1, offset: 0, hasMore: false
    }
  };
}

function buildHealthProjection(database: DatabaseSync, canvas: ProjectedCanvasRows, input: { includeResolved?: boolean; limit?: number; offset?: number }) {
  const page = listCanvasHealthIssues(database, { includeResolved: input.includeResolved, limit: input.limit, offset: input.offset });
  const nodeIdByObjectId = new Map<string, string>();
  for (const node of canvas.nodes) if (node.objectId) nodeIdByObjectId.set(node.objectId, node.id);
  const issues: KnowledgeCanvasHealthIssueProjection[] = page.items.map((issue) => ({
    ...issue,
    matchedNodeId: issue.affectedObjectId ? (nodeIdByObjectId.get(issue.affectedObjectId) ?? null) : null
  }));
  const healthIssueIdsByNode = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.matchedNodeId) {
      const list = healthIssueIdsByNode.get(issue.matchedNodeId) ?? [];
      list.push(issue.id);
      healthIssueIdsByNode.set(issue.matchedNodeId, list);
    }
  }
  const nodes = canvas.nodes.map((node) => {
    const projected = projectNode(database, node);
    const ids = healthIssueIdsByNode.get(node.id);
    return ids && ids.length ? { ...projected, healthIssueIds: ids } : projected;
  });
  return { nodes, issues, page };
}

/**
 * WMB-5213：三模式有界投影。同一 canvasId 下 relation/change/health 返回同一 nodes 身份
 * （同一 canvas node id + 同一正式对象 id），模式只是强调层；复用 v56 读 API，不造表。
 */
export function getKnowledgeCanvasProjection(database: DatabaseSync, input: KnowledgeCanvasProjectionInput): KnowledgeCanvasProjection {
  const canvas = getKnowledgeCanvas(database, input.canvasId) as unknown as ProjectedCanvasRows;
  const base = {
    canvasId: canvas.id, canvas: canvasSnapshot(canvas),
    // 画布 relations 为既有 v18/v21 行（列与 KnowledgeCanvasProjectedRelation 对齐），一次收紧边界。
    relations: canvas.relations as unknown as readonly KnowledgeCanvasProjectedRelation[],
    suggestions: canvas.suggestions ?? [], updatedAt: new Date().toISOString()
  };
  if (input.mode === 'change') {
    const projected = buildChangeProjection(database, canvas, input.changeSetId);
    return { mode: 'change', ...base, nodes: projected.nodes, modeData: projected.modeData };
  }
  if (input.mode === 'health') {
    const projected = buildHealthProjection(database, canvas, { includeResolved: input.includeResolvedIssues, limit: input.limit, offset: input.offset });
    const { total, limit, offset, hasMore } = projected.page;
    return {
      mode: 'health', ...base, nodes: projected.nodes,
      modeData: { changeSet: null, receipt: null, healthIssues: projected.issues, total, limit, offset, hasMore }
    };
  }
  return {
    mode: 'relation', ...base, nodes: canvas.nodes.map((node) => projectNode(database, node)),
    modeData: { changeSet: null, receipt: null, healthIssues: null, total: canvas.nodes.length, limit: canvas.nodes.length, offset: 0, hasMore: false }
  };
}

function mapNoteRecord(row: Record<string, unknown>): KnowledgeNoteRecord {
  return {
    id: String(row.id), scope: row.scope as KnowledgeNoteRecord['scope'], kind: row.kind as KnowledgeNoteRecord['kind'],
    canonicalKey: String(row.canonicalKey), title: String(row.title), lifecycle: row.lifecycle as KnowledgeNoteRecord['lifecycle'],
    mergedIntoNoteId: (row.mergedIntoNoteId as string | null) ?? null, supersededByNoteId: (row.supersededByNoteId as string | null) ?? null,
    currentVersionId: (row.currentVersionId as string | null) ?? null, revision: Number(row.revision),
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), archivedAt: (row.archivedAt as string | null) ?? null
  };
}

function mapEntityRecord(row: Record<string, unknown>): KnowledgeEntityRecord {
  return {
    id: String(row.id), scope: row.scope as KnowledgeEntityRecord['scope'], entityType: row.entityType as KnowledgeEntityRecord['entityType'],
    canonicalKey: String(row.canonicalKey), canonicalName: String(row.canonicalName),
    aliases: JSON.parse(String(row.aliasesJson)) as string[], externalIdentity: JSON.parse(String(row.externalIdentityJson)) as Record<string, unknown>,
    lifecycle: row.lifecycle as KnowledgeEntityRecord['lifecycle'],
    mergedIntoEntityId: (row.mergedIntoEntityId as string | null) ?? null, supersededByEntityId: (row.supersededByEntityId as string | null) ?? null,
    revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), archivedAt: (row.archivedAt as string | null) ?? null
  };
}

const NOTE_SELECT = `SELECT DISTINCT n.id, n.scope, n.kind, n.canonical_key AS canonicalKey, n.title, n.lifecycle, n.merged_into_note_id AS mergedIntoNoteId,
  n.superseded_by_note_id AS supersededByNoteId, n.current_version_id AS currentVersionId, n.revision, n.created_at AS createdAt,
  n.updated_at AS updatedAt, n.archived_at AS archivedAt FROM knowledge_notes`;
const ENTITY_SELECT = `SELECT e.id, e.scope, e.entity_type AS entityType, e.canonical_key AS canonicalKey, e.canonical_name AS canonicalName,
  e.aliases_json AS aliasesJson, e.external_identity_json AS externalIdentityJson, e.lifecycle, e.merged_into_entity_id AS mergedIntoEntityId,
  e.superseded_by_entity_id AS supersededByEntityId, e.revision, e.created_at AS createdAt, e.updated_at AS updatedAt, e.archived_at AS archivedAt
  FROM knowledge_entities e`;

function readRelatedNotes(database: DatabaseSync, node: ProjectedCanvasNodeRow): KnowledgeNoteRecord[] {
  try {
    if (node.objectType === 'topic' && node.objectId) {
      return (database.prepare(`${NOTE_SELECT} n
        JOIN knowledge_note_versions v ON v.note_id = n.id, json_each(v.adopted_topic_ids_json) j
        WHERE j.value = ? AND n.lifecycle = 'active' ORDER BY n.updated_at DESC, n.id LIMIT 20`).all(node.objectId) as Record<string, unknown>[])
        .map(mapNoteRecord);
    }
    const evidenceTypes = EVIDENCE_OBJECT_TYPES_BY_NODE[node.objectType] ?? [];
    if (node.objectId && evidenceTypes.length) {
      const placeholders = evidenceTypes.map(() => '?').join(',');
      const args = [...evidenceTypes, node.objectId];
      return (database.prepare(`${NOTE_SELECT} n
        JOIN knowledge_note_versions v ON v.note_id = n.id
        JOIN knowledge_evidence_links el ON el.knowledge_note_version_id = v.id
        WHERE el.evidence_object_type IN (${placeholders}) AND el.evidence_object_id = ? AND n.lifecycle = 'active'
        ORDER BY n.updated_at DESC, n.id LIMIT 20`).all(...args) as Record<string, unknown>[])
        .map(mapNoteRecord);
    }
  } catch {
    // 精简 fixture 缺 v56 表 → 无关联笔记
  }
  return [];
}

function readRelatedEntities(database: DatabaseSync, noteIds: string[]): KnowledgeEntityRecord[] {
  if (!noteIds.length) return [];
  try {
    const placeholders = noteIds.map(() => '?').join(',');
    return (database.prepare(`${ENTITY_SELECT}
      WHERE e.id IN (SELECT DISTINCT j.value FROM knowledge_note_versions v, json_each(v.adopted_entity_ids_json) j
        WHERE v.note_id IN (${placeholders})) AND e.lifecycle = 'active'
      ORDER BY e.updated_at DESC, e.id LIMIT 10`).all(...noteIds) as Record<string, unknown>[])
      .map(mapEntityRecord);
  } catch {
    return [];
  }
}

function readRelatedHealthIssues(database: DatabaseSync, node: ProjectedCanvasNodeRow): KnowledgeHealthIssueRecord[] {
  if (!node.objectId) return [];
  try {
    return (database.prepare(`SELECT id, scope, issue_type AS issueType, affected_object_type AS affectedObjectType,
      affected_object_id AS affectedObjectId, severity, evidence_json AS evidenceJson, suggested_action AS suggestedAction, status,
      resolution_note AS resolutionNote, resolved_change_set_id AS resolvedChangeSetId, detected_at AS detectedAt,
      updated_at AS updatedAt, resolved_at AS resolvedAt, revision
      FROM knowledge_health_issues WHERE affected_object_id = ? AND status IN ('open','repairing')
      ORDER BY detected_at DESC, id DESC LIMIT 10`).all(node.objectId) as Record<string, unknown>[])
      .map((row) => ({ ...row, evidence: JSON.parse(String(row.evidenceJson)) })) as unknown as KnowledgeHealthIssueRecord[];
  } catch {
    return [];
  }
}

/**
 * WMB-5213：画布节点详情深链数据。正式对象（wiki 当前页/笔记/实体）+ 健康问题 + 最近变化，
 * 全部复用 v56 读模型；深链 ID 即既有正式对象稳定 ID。
 */
export function getCanvasNodeDetail(database: DatabaseSync, input: KnowledgeCanvasNodeDetailInput): KnowledgeCanvasNodeDetail {
  const canvas = getKnowledgeCanvas(database, input.canvasId) as unknown as ProjectedCanvasRows;
  const node = canvas.nodes.find((item) => item.id === input.nodeId);
  if (!node) throw new Error('NODE_NOT_FOUND');
  let wikiPage: KnowledgeWikiPageRecord | null = null, wikiPageVersion: KnowledgeWikiPageVersionRecord | null = null;
  const deepLink = deepLinkForNode(database, node);
  if (deepLink?.formalObjectId) {
    try {
      const detail = getWikiPage(database, deepLink.formalObjectId);
      // store 记录类型较宽松（scope/pageType 为 string 别名），在共享契约边界收紧。
      wikiPage = (detail?.page ?? null) as KnowledgeWikiPageRecord | null;
      wikiPageVersion = (detail?.version ?? null) as unknown as KnowledgeWikiPageVersionRecord | null;
    } catch {
      // 精简 fixture 缺表 → 无 wiki 页
    }
  }
  const notes = readRelatedNotes(database, node);
  const entities = readRelatedEntities(database, notes.map((note) => note.id));
  const healthIssues = readRelatedHealthIssues(database, node);
  let recentChanges: KnowledgeChangeSetRecord[] = [];
  try { recentChanges = listChangeSets(database, { limit: 8 }).items; } catch { /* 精简 fixture */ }
  // WMB-5233：诚实三态（与投影节点同一判定；空壳不显示已编译）。
  const body = wikiPageVersion?.body && typeof wikiPageVersion.body === 'object'
    ? wikiPageVersion.body as Readonly<Record<string, unknown>>
    : null;
  const compileState = classifyWikiCompileState({ page: wikiPage, current: wikiPageVersion, body });
  return { node: projectNode(database, node), formal: { wikiPage, wikiPageVersion, notes, entities, healthIssues, recentChanges, compileState } };
}

/**
 * WMB-5213：selected-only 创作动作的规范输入清单。返回精确选中对象清单（同画布节点顺序），
 * 越界/重复节点拒绝；UI 展示的清单与正式写（preview/create 包）必须为同一份。
 */
export function validateKnowledgeSelectionManifest(database: DatabaseSync, input: KnowledgeCanvasSelectionManifestInput): KnowledgeCanvasSelectionManifest {
  // WMB-5243：全局知识网络选择清单（canvasId='global'；nodeIds 为稳定网络节点 ID，冻结正文包）。
  if (input.canvasId === KNOWLEDGE_NETWORK_CANVAS_ID) {
    return buildGlobalSelection(database, input.nodeIds).manifest;
  }
  const canvas = getKnowledgeCanvas(database, input.canvasId) as unknown as ProjectedCanvasRows;
  const candidateIds = [...new Set(input.nodeIds)];
  if (!candidateIds.length) throw new Error('PACKAGE_ITEMS_REQUIRED');
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  for (const id of candidateIds) if (!byId.has(id)) throw new Error('PACKAGE_NODE_NOT_FOUND');
  const items = canvas.nodes
    .filter((node) => candidateIds.includes(node.id))
    .map((node) => ({
      nodeId: node.id, objectType: node.objectType, objectId: node.objectId ?? null,
      title: node.objectType === 'note' ? (node.noteTitle ?? '') : (typeof node.object?.title === 'string' ? node.object.title : ''),
      snapshot: node.object ?? null
    }));
  const estimatedCharacters = JSON.stringify({ items }).length;
  return {
    scope: 'selected_only', canvasId: input.canvasId, items,
    // 旧画布路径：无效节点拒绝、无限长裁剪；未纳入仅来自静默去重（重复正式身份）。
    excludedCount: input.nodeIds.length - candidateIds.length,
    estimatedCharacters,
    limitCharacters: KNOWLEDGE_PACKAGE_CHARACTER_LIMIT, overLimit: estimatedCharacters > KNOWLEDGE_PACKAGE_CHARACTER_LIMIT
  };
}

export function addKnowledgeCanvasNode(database: DatabaseSync, input: {
  canvasId: string; objectType: ObjectType; objectId?: string; noteTitle?: string; noteText?: string; x: number; y: number;
}) {
  const canvas = database.prepare('SELECT id FROM knowledge_canvases WHERE id=? AND archived_at IS NULL').get(input.canvasId);
  if (!canvas) throw new Error('CANVAS_NOT_FOUND');
  if (input.objectType === 'note') {
    if (!input.noteTitle?.trim()) throw new Error('NOTE_TITLE_REQUIRED');
  } else resolveObject(database, input.objectType, input.objectId ?? null);
  const id = randomUUID(), now = new Date().toISOString();
  database.prepare(`INSERT INTO knowledge_canvas_nodes
    (id,canvas_id,object_type,object_id,note_title,note_text,x,y,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.objectType,input.objectId ?? null,input.noteTitle?.trim() ?? null,input.noteText ?? null,input.x,input.y,now,now);
  return (getKnowledgeCanvas(database, input.canvasId) as any).nodes.find((node: any) => node.id === id);
}

export function moveKnowledgeCanvasNodes(database: DatabaseSync, input: { canvasId: string; nodes: Array<{ id: string; x: number; y: number; expectedRevision: number }> }, transaction = true) {
  const now = new Date().toISOString();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    for (const item of input.nodes) {
      const row = database.prepare('SELECT revision FROM knowledge_canvas_nodes WHERE id=? AND canvas_id=?').get(item.id,input.canvasId) as { revision: number } | undefined;
      if (!row) throw new Error('NODE_NOT_FOUND');
      assertRevision(row.revision,item.expectedRevision);
      database.prepare('UPDATE knowledge_canvas_nodes SET x=?,y=?,updated_at=?,revision=revision+1 WHERE id=?').run(item.x,item.y,now,item.id);
    }
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return getKnowledgeCanvas(database,input.canvasId);
}

export function removeKnowledgeCanvasNode(database: DatabaseSync, input: { canvasId: string; nodeId: string; expectedRevision: number }) {
  const row = database.prepare('SELECT revision FROM knowledge_canvas_nodes WHERE id=? AND canvas_id=?').get(input.nodeId,input.canvasId) as { revision: number } | undefined;
  if (!row) throw new Error('NODE_NOT_FOUND');
  assertRevision(row.revision,input.expectedRevision);
  database.prepare('DELETE FROM knowledge_canvas_nodes WHERE id=?').run(input.nodeId);
  return { id: input.nodeId, removed: true };
}

export function createKnowledgeRelation(database: DatabaseSync, input: {
  canvasId: string; fromNodeId: string; toNodeId: string; relationType: string; label?: string; createdBy?: 'user' | 'pi';
}) {
  if (!relationTypes.has(input.relationType)) throw new Error('INVALID_RELATION_TYPE');
  if (input.fromNodeId === input.toNodeId) throw new Error('RELATION_SELF_REFERENCE');
  const count = Number((database.prepare('SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (?,?)')
    .get(input.canvasId,input.fromNodeId,input.toNodeId) as { count: number }).count);
  if (count !== 2) throw new Error('RELATION_ENDPOINT_NOT_FOUND');
  const id = randomUUID(), now = new Date().toISOString(), createdBy = input.createdBy ?? 'user';
  const archived=database.prepare(`SELECT id FROM knowledge_relations
    WHERE canvas_id=? AND from_node_id=? AND to_node_id=? AND relation_type=? AND archived_at IS NOT NULL`)
    .get(input.canvasId,input.fromNodeId,input.toNodeId,input.relationType) as {id:string}|undefined;
  if(archived){
    database.prepare(`UPDATE knowledge_relations SET label=?,state=?,created_by=?,hidden=0,archived_at=NULL,updated_at=?,revision=revision+1 WHERE id=?`)
      .run(input.label?.trim()||null,createdBy==='pi'?'suggested':'confirmed',createdBy,now,archived.id);
    return database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,label,state,hidden,revision
      FROM knowledge_relations WHERE id=?`).get(archived.id);
  }
  database.prepare(`INSERT INTO knowledge_relations
    (id,canvas_id,from_node_id,to_node_id,relation_type,label,state,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.fromNodeId,input.toNodeId,input.relationType,input.label?.trim() || null,createdBy === 'pi' ? 'suggested' : 'confirmed',createdBy,now,now);
  return database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,label,state,hidden,revision
    FROM knowledge_relations WHERE id=?`).get(id);
}

export function updateKnowledgeRelation(database: DatabaseSync, input: {
  id: string; expectedRevision: number; fromNodeId?:string; toNodeId?:string; relationType?: string; label?: string; hidden?: boolean; archived?: boolean;
}) {
  if (input.relationType && !relationTypes.has(input.relationType)) throw new Error('INVALID_RELATION_TYPE');
  const current = database.prepare('SELECT revision,canvas_id AS canvasId,from_node_id AS fromNodeId,to_node_id AS toNodeId FROM knowledge_relations WHERE id=? AND archived_at IS NULL').get(input.id) as any;
  if (!current) throw new Error('RELATION_NOT_FOUND');
  assertRevision(current.revision,input.expectedRevision);
  const fromNodeId=input.fromNodeId??current.fromNodeId,toNodeId=input.toNodeId??current.toNodeId;
  if(fromNodeId===toNodeId)throw new Error('RELATION_SELF_REFERENCE');
  const endpoints=(database.prepare('SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (?,?)').get(current.canvasId,fromNodeId,toNodeId) as {count:number}).count;
  if(endpoints!==2)throw new Error('RELATION_ENDPOINT_NOT_FOUND');
  const now=new Date().toISOString();
  database.prepare(`UPDATE knowledge_relations SET from_node_id=?,to_node_id=?,relation_type=coalesce(?,relation_type),
    label=CASE WHEN ?=1 THEN ? ELSE label END,
    hidden=coalesce(?,hidden),archived_at=CASE WHEN ?=1 THEN ? ELSE archived_at END,updated_at=?,revision=revision+1 WHERE id=?`)
    .run(fromNodeId,toNodeId,input.relationType??null,input.label===undefined?0:1,input.label?.trim()||null,input.hidden===undefined?null:Number(input.hidden),input.archived?1:0,now,now,input.id);
  return input.archived ? {id:input.id,archived:true,revision:current.revision+1}
    : database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,label,state,hidden,revision
      FROM knowledge_relations WHERE id=?`).get(input.id);
}

function validateKnowledgeSuggestion(database:DatabaseSync,input:{canvasId:string;kind:'node'|'relation';payload:any}){
  if(!database.prepare('SELECT id FROM knowledge_canvases WHERE id=? AND archived_at IS NULL').get(input.canvasId))throw new Error('CANVAS_NOT_FOUND');
  if(input.kind==='node'){
    const payload=input.payload;
    if(payload.objectType==='note'){if(!String(payload.noteTitle??'').trim())throw new Error('NOTE_TITLE_REQUIRED');}
    else resolveObject(database,payload.objectType,payload.objectId??null);
    const returnFromNodeIds=[...new Set(Array.isArray(payload.returnFromNodeIds)?payload.returnFromNodeIds:[])] as string[];
    if(returnFromNodeIds.length){
      if(!relationTypes.has(payload.returnRelationType))throw new Error('INVALID_RELATION_TYPE');
      const count=Number((database.prepare(`SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (${returnFromNodeIds.map(()=>'?').join(',')})`).get(input.canvasId,...returnFromNodeIds) as {count:number}).count);
      if(count!==returnFromNodeIds.length)throw new Error('RELATION_ENDPOINT_NOT_FOUND');
    }
    return {objectType:payload.objectType,objectId:payload.objectId??undefined,noteTitle:payload.noteTitle?.trim(),noteText:payload.noteText??'',x:Number(payload.x??80),y:Number(payload.y??80),
      returnFromNodeIds,returnRelationType:returnFromNodeIds.length?payload.returnRelationType:undefined};
  }
  const payload=input.payload;
  if(!relationTypes.has(payload.relationType))throw new Error('INVALID_RELATION_TYPE');
  if(payload.fromNodeId===payload.toNodeId)throw new Error('RELATION_SELF_REFERENCE');
  const count=Number((database.prepare('SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (?,?)').get(input.canvasId,payload.fromNodeId,payload.toNodeId) as {count:number}).count);
  if(count!==2)throw new Error('RELATION_ENDPOINT_NOT_FOUND');
  return {fromNodeId:payload.fromNodeId,toNodeId:payload.toNodeId,relationType:payload.relationType,label:payload.label?.trim()||undefined};
}

export function createKnowledgeSuggestion(database:DatabaseSync,input:{requestId:string;canvasId:string;kind:'node'|'relation';payload:any}){
  const payload=validateKnowledgeSuggestion(database,input),id=randomUUID(),now=new Date().toISOString();
  database.prepare(`INSERT INTO knowledge_suggestions(id,request_id,canvas_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id,input.requestId,input.canvasId,input.kind,JSON.stringify(payload),now,now);
  return {id,canvasId:input.canvasId,kind:input.kind,payload,state:'suggested',createdAt:now,revision:1};
}


export function decideKnowledgeSuggestion(database:DatabaseSync,input:{id:string;expectedRevision:number;decision:'confirm'|'reject'}){
  const row=database.prepare(`SELECT id,canvas_id AS canvasId,kind,payload_json AS payloadJson,state,revision FROM knowledge_suggestions WHERE id=?`).get(input.id) as any;
  if(!row)throw new Error('SUGGESTION_NOT_FOUND');
  assertRevision(row.revision,input.expectedRevision);
  if(row.state!=='suggested')throw new Error('SUGGESTION_ALREADY_DECIDED');
  const payload=JSON.parse(row.payloadJson),now=new Date().toISOString();
  let created=null;
  if(input.decision==='confirm'){
    if(row.kind==='node'){
      const node=addKnowledgeCanvasNode(database,{canvasId:row.canvasId,...payload});
      const relations=(payload.returnFromNodeIds??[]).map((fromNodeId:string)=>createKnowledgeRelation(database,{canvasId:row.canvasId,fromNodeId,toNodeId:node.id,relationType:payload.returnRelationType}));
      created=relations.length?{node,relations}:node;
    }else created=createKnowledgeRelation(database,{canvasId:row.canvasId,...payload});
  }
  const state=input.decision==='confirm'?'confirmed':'rejected';
  database.prepare(`UPDATE knowledge_suggestions SET state=?,decided_at=?,updated_at=?,revision=revision+1 WHERE id=?`).run(state,now,now,row.id);
  return {id:row.id,state,revision:row.revision+1,created};
}


export const KNOWLEDGE_PACKAGE_CHARACTER_LIMIT=30000;

export function previewKnowledgeContextPackage(database:DatabaseSync,input:{
  canvasId:string;nodeIds:string[];excludedNodeIds?:string[];excludedRelationIds?:string[];
}){
  // WMB-5243：全局知识网络冻结选择包（canvasId='global'；稳定网络节点 ID；有界字符 + excluded）。
  if (input.canvasId === KNOWLEDGE_NETWORK_CANVAS_ID) {
    return previewGlobalKnowledgeContextPackage(database, input);
  }
  // WMB-5213：preview/create 与 selected-only 清单同源（validateKnowledgeSelectionManifest），
  // 保证 UI 展示的选中对象清单与服务端实际使用的对象集合完全一致。
  const manifest=validateKnowledgeSelectionManifest(database,{canvasId:input.canvasId,nodeIds:input.nodeIds});
  const excludedNodeIds=new Set(input.excludedNodeIds??[]),excludedRelationIds=new Set(input.excludedRelationIds??[]);
  const canvas = getKnowledgeCanvas(database,input.canvasId) as any;
  const selected=manifest.items.filter((item:any)=>!excludedNodeIds.has(item.nodeId));
  if(!selected.length)throw new Error('PACKAGE_ITEMS_REQUIRED');
  const selectedSet=new Set(selected.map((item:any)=>item.nodeId));
  const internal=canvas.relations.filter((relation:any)=>selectedSet.has(relation.fromNodeId)&&selectedSet.has(relation.toNodeId));
  const relations=internal.filter((relation:any)=>!excludedRelationIds.has(relation.id));
  const items=selected.map((item:any,index:number)=>({nodeId:item.nodeId,objectType:item.objectType,objectId:item.objectId??null,sortOrder:index,snapshot:item.snapshot}));
  const excluded=[
    ...manifest.items.filter((item:any)=>excludedNodeIds.has(item.nodeId)).map((item:any)=>({kind:'object',id:item.nodeId,objectType:item.objectType,reason:'user_excluded'})),
    ...internal.filter((relation:any)=>excludedRelationIds.has(relation.id)).map((relation:any)=>({kind:'relation',id:relation.id,relationType:relation.relationType,reason:'user_excluded'}))
  ];
  const estimatedCharacters=JSON.stringify({items,relations}).length;
  return {scope:'selected_only',items,relations,excluded,excludedCount:excluded.length,truncated:false,estimatedCharacters,limitCharacters:KNOWLEDGE_PACKAGE_CHARACTER_LIMIT,overLimit:estimatedCharacters>KNOWLEDGE_PACKAGE_CHARACTER_LIMIT};
}

export function createKnowledgeContextPackage(database: DatabaseSync, input: {
  canvasId: string; name: string; objective: string; instruction?: string; nodeIds: string[];
  excludedNodeIds?:string[];excludedRelationIds?:string[];familyId?:string;
}, transaction = true) {
  // WMB-5243：全局知识网络为只读投影；正式创作包仍是画布作用域遗留能力（canvas_id FK 要求真实画布，
  // 不造 'global' 伪画布行）。全局网络选择只经 manifest/preview（Pi 上下文），不创建包。
  if (input.canvasId === KNOWLEDGE_NETWORK_CANVAS_ID) {
    throw new Error('PACKAGE_GLOBAL_CREATE_UNSUPPORTED');
  }
  if (!input.name.trim() || !input.objective.trim()) throw new Error('PACKAGE_DETAILS_REQUIRED');
  const preview=previewKnowledgeContextPackage(database,input);
  if(preview.overLimit)throw new Error('PACKAGE_TOO_LARGE');
  const id = randomUUID(), now = new Date().toISOString();
  const familyId=input.familyId??id;
  const versionNumber=input.familyId?Number((database.prepare('SELECT coalesce(max(version_number),0)+1 AS version FROM knowledge_context_packages WHERE family_id=?').get(input.familyId) as {version:number}).version):1;
  if(input.familyId&&!database.prepare('SELECT id FROM knowledge_context_packages WHERE family_id=? LIMIT 1').get(input.familyId))throw new Error('PACKAGE_FAMILY_NOT_FOUND');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO knowledge_context_packages(id,canvas_id,name,objective,instruction,created_at,updated_at,family_id,version_number,excluded_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.name.trim(),input.objective.trim(),input.instruction?.trim() ?? '',now,now,familyId,versionNumber,JSON.stringify(preview.excluded));
    const insertItem = database.prepare(`INSERT INTO knowledge_context_package_items(package_id,node_id,object_type,object_id,sort_order,snapshot_json)
      VALUES(?,?,?,?,?,?)`);
    preview.items.forEach((item: any) => insertItem.run(id,item.nodeId,item.objectType,item.objectId,item.sortOrder,JSON.stringify(item.snapshot)));
    const insertRelation = database.prepare(`INSERT INTO knowledge_context_package_relations(package_id,relation_id,snapshot_json) VALUES(?,?,?)`);
    preview.relations.forEach((relation: any) => insertRelation.run(id,relation.id,JSON.stringify(relation)));
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return getKnowledgeContextPackage(database,id);
}

export function createKnowledgeContextPackageIdempotent(database: DatabaseSync, input: {
  requestId:string;canvasId:string;name:string;objective:string;instruction?:string;nodeIds:string[];
  excludedNodeIds?:string[];excludedRelationIds?:string[];familyId?:string;
}) {
  const tool='knowledge.context_package_create';
  const prior=database.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get(tool,input.requestId) as {resultJson:string}|undefined;
  if(prior)return {...JSON.parse(prior.resultJson),replayed:true};
  database.exec('BEGIN IMMEDIATE');
  try{
    const data=createKnowledgeContextPackage(database,input,false);
    const payload={ok:true,data,error:null};
    database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run(tool,input.requestId,JSON.stringify(payload),new Date().toISOString());
    database.exec('COMMIT');
    return {...payload,replayed:false};
  }catch(error){database.exec('ROLLBACK');throw error;}
}

export function getKnowledgeContextPackage(database: DatabaseSync, id: string) {
  const info = database.prepare(`SELECT id,canvas_id AS canvasId,name,objective,instruction,scope,created_at AS createdAt,revision,
    family_id AS familyId,version_number AS versionNumber,excluded_json AS excludedJson
    FROM knowledge_context_packages WHERE id=? AND archived_at IS NULL`).get(id);
  if (!info) throw new Error('PACKAGE_NOT_FOUND');
  const items = (database.prepare(`SELECT node_id AS nodeId,object_type AS objectType,object_id AS objectId,sort_order AS sortOrder,snapshot_json AS snapshotJson
    FROM knowledge_context_package_items WHERE package_id=? ORDER BY sort_order`).all(id) as any[])
    .map(({ snapshotJson, ...item }) => ({ ...item, snapshot: JSON.parse(snapshotJson) }));
  const relations = (database.prepare('SELECT snapshot_json AS snapshotJson FROM knowledge_context_package_relations WHERE package_id=? ORDER BY relation_id').all(id) as any[])
    .map(({ snapshotJson }) => JSON.parse(snapshotJson));
  const manifest = { packageId: id, packageRevision: (info as any).revision, scope: 'selected_only', objective: (info as any).objective,
    instruction: (info as any).instruction, items, relations, excluded: JSON.parse((info as any).excludedJson), truncated: false,
    estimatedCharacters: JSON.stringify({ items, relations }).length,limitCharacters:KNOWLEDGE_PACKAGE_CHARACTER_LIMIT };
  const uses=(database.prepare(`SELECT id,request_id AS requestId,purpose,pi_session_id AS piSessionId,
    content_project_id AS contentProjectId,manifest_json AS manifestJson,created_at AS createdAt
    FROM knowledge_context_uses WHERE package_id=? ORDER BY created_at,id`).all(id) as any[])
    .map(({manifestJson,...use})=>({...use,manifest:JSON.parse(manifestJson)}));
  const projects=database.prepare(`SELECT link.project_id AS projectId,project.title,link.package_revision AS packageRevision,
    link.use_id AS useId,link.created_at AS createdAt FROM content_project_context_packages link
    JOIN content_projects project ON project.id=link.project_id WHERE link.package_id=? ORDER BY link.created_at,link.project_id`).all(id);
  const versions=database.prepare(`SELECT id,version_number AS versionNumber,created_at AS createdAt,archived_at AS archivedAt,revision
    FROM knowledge_context_packages WHERE family_id=? ORDER BY version_number DESC`).all((info as any).familyId);
  const {excludedJson,...packageInfo}=info as any;
  return { ...packageInfo, items, relations, manifest, uses, projects,versions };
}

export function listKnowledgeContextPackages(database:DatabaseSync,input:{query?:string;archived?:boolean;limit?:number;offset?:number}={}){
  const limit=Math.min(Math.max(input.limit??50,1),100),offset=Math.max(input.offset??0,0),query=input.query?.trim()??'',pattern=`%${query}%`;
  const archiveClause=input.archived?'p.archived_at IS NOT NULL':'p.archived_at IS NULL';
  const args=[query,pattern,pattern];
  const where=`${archiveClause} AND (?='' OR p.name LIKE ? OR p.objective LIKE ?)`;
  const total=Number((database.prepare(`SELECT count(*) count FROM knowledge_context_packages p WHERE ${where}`).get(...args) as {count:number}).count);
  const items=database.prepare(`SELECT p.id,p.family_id AS familyId,p.version_number AS versionNumber,p.name,p.objective,p.created_at AS createdAt,
    p.archived_at AS archivedAt,p.revision,(SELECT count(*) FROM knowledge_context_package_items i WHERE i.package_id=p.id) itemCount,
    (SELECT count(*) FROM knowledge_context_package_relations r WHERE r.package_id=p.id) relationCount,
    (SELECT count(*) FROM knowledge_context_uses u WHERE u.package_id=p.id) useCount
    FROM knowledge_context_packages p WHERE ${where} ORDER BY p.updated_at DESC,p.id LIMIT ? OFFSET ?`).all(...args,limit,offset);
  return {items,total,limit,offset,hasMore:offset+items.length<total};
}

export function archiveKnowledgeContextPackage(database:DatabaseSync,input:{id:string;expectedRevision:number}){
  const row=database.prepare('SELECT revision FROM knowledge_context_packages WHERE id=? AND archived_at IS NULL').get(input.id) as {revision:number}|undefined;
  if(!row)throw new Error('PACKAGE_NOT_FOUND');assertRevision(row.revision,input.expectedRevision);
  const now=new Date().toISOString();database.prepare('UPDATE knowledge_context_packages SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(now,now,input.id);
  return {id:input.id,archived:true,revision:row.revision+1};
}

export function recordKnowledgeContextUse(database: DatabaseSync, input: {
  requestId: string; packageId: string; expectedRevision: number; purpose: 'discussion'|'creation';
  piSessionId?: string; contentProjectId?: string;
}, transaction = true) {
  if (!input.requestId.trim()) throw new Error('REQUEST_ID_REQUIRED');
  const prior=database.prepare('SELECT id,package_id AS packageId,package_revision AS packageRevision,purpose,pi_session_id AS piSessionId,content_project_id AS contentProjectId,manifest_json AS manifestJson,created_at AS createdAt FROM knowledge_context_uses WHERE request_id=?').get(input.requestId) as any;
  if(prior)return {...prior,manifest:JSON.parse(prior.manifestJson),replayed:true};
  const pack=getKnowledgeContextPackage(database,input.packageId) as any;
  assertRevision(pack.revision,input.expectedRevision);
  if(input.contentProjectId&&!database.prepare('SELECT id FROM content_projects WHERE id=?').get(input.contentProjectId))throw new Error('CONTENT_PROJECT_NOT_FOUND');
  const id=randomUUID(),now=new Date().toISOString(),manifestJson=JSON.stringify(pack.manifest);
  if(transaction)database.exec('BEGIN IMMEDIATE');
  try{
    database.prepare(`INSERT INTO knowledge_context_uses(id,package_id,package_revision,purpose,pi_session_id,content_project_id,manifest_json,created_at,request_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id,input.packageId,pack.revision,input.purpose,input.piSessionId??null,input.contentProjectId??null,manifestJson,now,input.requestId);
    if(input.contentProjectId){
      database.prepare(`INSERT INTO content_project_context_packages(project_id,package_id,package_revision,use_id,created_at) VALUES(?,?,?,?,?)`)
        .run(input.contentProjectId,input.packageId,pack.revision,id,now);
      const linkSource=database.prepare('INSERT OR IGNORE INTO content_project_sources(project_id,source_id) VALUES(?,?)');
      pack.items.filter((item:any)=>item.objectType==='source'&&item.objectId).forEach((item:any)=>linkSource.run(input.contentProjectId!,item.objectId));
    }
    if(transaction)database.exec('COMMIT');
  }catch(error){if(transaction)database.exec('ROLLBACK');throw error;}
  return {id,requestId:input.requestId,packageId:input.packageId,packageRevision:pack.revision,purpose:input.purpose,
    piSessionId:input.piSessionId??null,contentProjectId:input.contentProjectId??null,manifest:pack.manifest,createdAt:now,replayed:false};
}

export function getContentProjectContextPackages(database: DatabaseSync, projectId: string) {
  if(!database.prepare('SELECT id FROM content_projects WHERE id=?').get(projectId))throw new Error('CONTENT_PROJECT_NOT_FOUND');
  return database.prepare(`SELECT link.package_id AS packageId,package.name,link.package_revision AS packageRevision,
    link.use_id AS useId,link.created_at AS createdAt FROM content_project_context_packages link
    JOIN knowledge_context_packages package ON package.id=link.package_id WHERE link.project_id=? ORDER BY link.created_at,link.package_id`).all(projectId);
}

function readCreativeBrief(row:any){
  if(!row)return null;
  const {structureJson,evidenceNodeIdsJson,contextNodeIdsJson,...brief}=row;
  return {...brief,structure:JSON.parse(structureJson),evidenceNodeIds:JSON.parse(evidenceNodeIdsJson),contextNodeIds:JSON.parse(contextNodeIdsJson)};
}

export function getCreativeBriefForPackage(database:DatabaseSync,packageId:string){
  return readCreativeBrief(database.prepare(`SELECT id,package_id AS packageId,package_revision AS packageRevision,title,
    core_judgment AS coreJudgment,why_now AS whyNow,structure_json AS structureJson,evidence_node_ids_json AS evidenceNodeIdsJson,
    canvas_id AS canvasId,selection_mode AS selectionMode,context_node_ids_json AS contextNodeIdsJson,
    status,created_at AS createdAt,updated_at AS updatedAt,revision FROM creative_briefs WHERE package_id=?`).get(packageId));
}

export function getCreativeBrief(database:DatabaseSync,id:string){
  return readCreativeBrief(database.prepare(`SELECT id,package_id AS packageId,package_revision AS packageRevision,title,
    core_judgment AS coreJudgment,why_now AS whyNow,structure_json AS structureJson,evidence_node_ids_json AS evidenceNodeIdsJson,
    canvas_id AS canvasId,selection_mode AS selectionMode,context_node_ids_json AS contextNodeIdsJson,
    status,created_at AS createdAt,updated_at AS updatedAt,revision FROM creative_briefs WHERE id=?`).get(id));
}

export function getCreativeBriefForContext(database:DatabaseSync,input:{canvasId:string;nodeIds:string[]}){
  const contextNodeIdsJson=JSON.stringify([...new Set(input.nodeIds)].sort());
  return readCreativeBrief(database.prepare(`SELECT id,package_id AS packageId,package_revision AS packageRevision,title,
    core_judgment AS coreJudgment,why_now AS whyNow,structure_json AS structureJson,evidence_node_ids_json AS evidenceNodeIdsJson,
    canvas_id AS canvasId,selection_mode AS selectionMode,context_node_ids_json AS contextNodeIdsJson,
    status,created_at AS createdAt,updated_at AS updatedAt,revision FROM creative_briefs
    WHERE canvas_id=? AND context_node_ids_json=? ORDER BY updated_at DESC,id LIMIT 1`).get(input.canvasId,contextNodeIdsJson));
}

function validateCreativeBriefFields(input:{title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[]},allowed:Set<string>){
  const title=input.title.trim(),coreJudgment=input.coreJudgment.trim(),whyNow=input.whyNow.trim();
  const structure=input.structure.map(item=>item.trim()).filter(Boolean);
  if(!title||!coreJudgment||!whyNow||!structure.length)throw new Error('BRIEF_FIELDS_REQUIRED');
  const evidenceNodeIds=[...new Set(input.evidenceNodeIds)];
  if(evidenceNodeIds.some(id=>!allowed.has(id)))throw new Error('BRIEF_EVIDENCE_OUTSIDE_CONTEXT');
  return {title,coreJudgment,whyNow,structure,evidenceNodeIds};
}

export function createCreativeBrief(database:DatabaseSync,input:{
  canvasId:string;nodeIds:string[];selectionMode:'current_page'|'selected';title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[];
}){
  const context=previewKnowledgeContextPackage(database,{canvasId:input.canvasId,nodeIds:input.nodeIds});
  if(context.overLimit)throw new Error('CONTEXT_TOO_LARGE');
  const contextNodeIds=context.items.map((item:any)=>item.nodeId).sort();
  const value=validateCreativeBriefFields(input,new Set(contextNodeIds)),id=randomUUID(),now=new Date().toISOString();
  database.prepare(`INSERT INTO creative_briefs(id,canvas_id,selection_mode,context_node_ids_json,title,core_judgment,why_now,structure_json,evidence_node_ids_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.selectionMode,JSON.stringify(contextNodeIds),value.title,value.coreJudgment,value.whyNow,JSON.stringify(value.structure),JSON.stringify(value.evidenceNodeIds),now,now);
  return getCreativeBrief(database,id);
}


export function updateCreativeBrief(database:DatabaseSync,input:{
  id:string;expectedRevision:number;title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[];status?:'draft'|'confirmed';
}){
  const current=database.prepare('SELECT context_node_ids_json AS contextNodeIdsJson,revision FROM creative_briefs WHERE id=?').get(input.id) as any;
  if(!current)throw new Error('BRIEF_NOT_FOUND');
  assertRevision(current.revision,input.expectedRevision);
  const value=validateCreativeBriefFields(input,new Set(JSON.parse(current.contextNodeIdsJson))),now=new Date().toISOString();
  database.prepare(`UPDATE creative_briefs SET title=?,core_judgment=?,why_now=?,structure_json=?,evidence_node_ids_json=?,status=?,updated_at=?,revision=revision+1 WHERE id=?`)
    .run(value.title,value.coreJudgment,value.whyNow,JSON.stringify(value.structure),JSON.stringify(value.evidenceNodeIds),input.status??'draft',now,input.id);
  return getCreativeBrief(database,input.id);
}


export function getCreativeBriefLineage(database:DatabaseSync,briefId:string){
  const brief=getCreativeBrief(database,briefId);
  if(!brief)throw new Error('BRIEF_NOT_FOUND');
  const link=database.prepare('SELECT project_id AS projectId,created_at AS createdAt FROM creative_brief_projects WHERE brief_id=?').get(briefId) as any;
  const project=link?getContentProject(database,link.projectId):null;
  const publications=link?database.prepare(`SELECT p.id,p.platform,p.status,p.external_url AS externalUrl,p.published_at AS publishedAt
    FROM publications p JOIN platform_versions pv ON pv.id=p.platform_version_id WHERE pv.project_id=? ORDER BY p.created_at,p.id`).all(link.projectId):[];
  const publicationIds=(publications as any[]).map(item=>item.id);
  const metrics=publicationIds.length?database.prepare(`SELECT id,publication_id AS publicationId,captured_at AS capturedAt,normalized_json AS normalizedJson
    FROM publication_metric_snapshots WHERE publication_id IN (${publicationIds.map(()=>'?').join(',')}) ORDER BY captured_at,id`).all(...publicationIds).map((row:any)=>({...row,normalized:JSON.parse(row.normalizedJson)})):[];
  const reviews=publicationIds.length?database.prepare(`SELECT id,publication_id AS publicationId,status,summary,revision FROM reviews
    WHERE publication_id IN (${publicationIds.map(()=>'?').join(',')}) ORDER BY created_at,id`).all(...publicationIds):[];
  const reviewIds=(reviews as any[]).map(item=>item.id);
  const findings=reviewIds.length?database.prepare(`SELECT id,review_id AS reviewId,title,body,revision FROM method_findings
    WHERE review_id IN (${reviewIds.map(()=>'?').join(',')}) ORDER BY created_at,id`).all(...reviewIds):[];
  return {brief,link:link??null,project,publications,metrics,reviews,findings};
}

export function createContentProjectFromBrief(database:DatabaseSync,input:{briefId:string;expectedRevision:number}){
  const brief=getCreativeBrief(database,input.briefId);
  if(!brief)throw new Error('BRIEF_NOT_FOUND');
  assertRevision(brief.revision,input.expectedRevision);
  if(brief.status!=='confirmed')throw new Error('BRIEF_NOT_CONFIRMED');
  const existing=database.prepare('SELECT project_id AS projectId FROM creative_brief_projects WHERE brief_id=?').get(input.briefId) as {projectId:string}|undefined;
  if(existing)return getCreativeBriefLineage(database,input.briefId);
  const nodeIds=brief.contextNodeIds as string[],placeholders=nodeIds.map(()=>'?').join(',');
  const refs=nodeIds.length?database.prepare(`SELECT object_type AS objectType,object_id AS objectId FROM knowledge_canvas_nodes WHERE id IN (${placeholders})`).all(...nodeIds) as any[]:[];
  const sourceIds=refs.filter(item=>item.objectType==='source'&&item.objectId).map(item=>item.objectId);
  const topicId=refs.find(item=>item.objectType==='topic'&&item.objectId)?.objectId;
  const body=`# ${brief.title}\n\n${brief.coreJudgment}\n\n## 为什么现在\n\n${brief.whyNow}\n\n## 内容结构\n\n${brief.structure.map((item:string,index:number)=>`${index+1}. ${item}`).join('\n')}`;
  const now=new Date().toISOString();
  const project=createContentProjectWithVersion(database,{title:brief.title,body,sourceIds,topicId},false);
  database.prepare('INSERT INTO creative_brief_projects(brief_id,project_id,created_at) VALUES(?,?,?)').run(brief.id,project.id,now);
  return getCreativeBriefLineage(database,brief.id);
}

// ============================================================
// WMB-5243：全局 Wiki 知识网络只读投影 + 知识本体详情 + 冻结选择包（canvasId='global'）
// 稳定节点 ID = `<objectType>:<objectId>`（topic/knowledge_note/knowledge_entity）；
// 只读复用正式表与 v56 读 API（topics / knowledge_notes / knowledge_entities /
// knowledge_note_versions / knowledge_wiki_pages / knowledge_formal_relations + registry /
// knowledge_evidence_links），不造第二套 store/schema；旧画布接口保留仅供兼容已有数据。
// 投影分页有界（默认 500 / 上限 2000），节点 UNION 一次查询 + 关系一次查询 + 版本映射一批，
// 无 N+1。
// WMB-5255：关系集合 = 活动正式关系 + 当前版本派生采纳边（active 笔记 current_version 的
// adoptedTopicIds/adoptedEntityIds → note -> 主题/实体 about 边，稳定确定性 ID；
// 与正式关系同 from/to/relationType 时正式优先去重）；度数/filters/totalRelations/updatedAt
// 均以合并可见集合为口径。
// ============================================================

const NETWORK_DETAIL_EVIDENCE_LIMIT = 10;
const NETWORK_DETAIL_RELATED_LIMIT = 10;

/** 知识优先级（选择包超限时按此 + 选中顺序裁剪；topic > note > entity）。 */
const NETWORK_NODE_PRIORITY: Readonly<Record<string, number>> = Object.freeze({ topic: 0, knowledge_note: 1, knowledge_entity: 2 });

/** 可见端点类型（正式关系两端可出现的网络节点类型；knowledge_note_version 解析到其笔记）。 */
const NETWORK_VISIBLE_ENDPOINT_TYPES = "('topic','knowledge_note','knowledge_note_version','knowledge_entity')";

/** 三类节点 UNION（不带头尾 ORDER BY/LIMIT；列名：objectType/objectId/shortTitle/summary/updatedAt）。 */
function networkNodesUnion(nodeTypes: readonly KnowledgeNetworkNodeType[]): string {
  const branches: string[] = [];
  const types = new Set(nodeTypes);
  if (types.has('topic')) {
    branches.push(`SELECT 'topic' AS objectType, id AS objectId, title AS shortTitle, coalesce(summary,'') AS summary, updated_at AS updatedAt
      FROM topics WHERE status != 'archived'`);
  }
  if (types.has('knowledge_note')) {
    branches.push(`SELECT 'knowledge_note' AS objectType, n.id AS objectId, n.title AS shortTitle, coalesce(v.statement,'') AS summary, n.updated_at AS updatedAt
      FROM knowledge_notes n LEFT JOIN knowledge_note_versions v ON v.id = n.current_version_id
      WHERE n.lifecycle = 'active'`);
  }
  if (types.has('knowledge_entity')) {
    branches.push(`SELECT 'knowledge_entity' AS objectType, id AS objectId, canonical_name AS shortTitle, '' AS summary, updated_at AS updatedAt
      FROM knowledge_entities WHERE lifecycle = 'active'`);
  }
  return branches.map((sql) => `SELECT * FROM (${sql})`).join(' UNION ALL ');
}

type ResolvedNetworkRelation = {
  id: string;
  relationKey: string;
  from: string;
  to: string;
  displayName: string;
};

/**
 * 活动正式关系解析：knowledge_formal_relations 活动行，端点类型 ∈ 网络可见类型，
 * knowledge_note_version 端点经一批版本映射解析到其笔记；两端均映射到可见节点才算有效。
 * objectIds 为 null → 全图；否则只取触及任一对象的行（对象详情/选择包用，有界）。
 */
function resolveActiveNetworkRelations(database: DatabaseSync, objectIds: readonly string[] | null): ResolvedNetworkRelation[] {
  const select = `SELECT r.id, r.relation_key AS relationKey, r.from_object_type AS fromObjectType, r.from_object_id AS fromObjectId,
    r.to_object_type AS toObjectType, r.to_object_id AS toObjectId, coalesce(reg.display_name, r.relation_key) AS displayName
    FROM knowledge_formal_relations r
    LEFT JOIN knowledge_relation_registry reg ON reg.relation_key = r.relation_key`;
  const rows = objectIds === null
    ? database.prepare(`${select}
        WHERE r.ended_change_set_id IS NULL
          AND r.from_object_type IN ${NETWORK_VISIBLE_ENDPOINT_TYPES}
          AND r.to_object_type IN ${NETWORK_VISIBLE_ENDPOINT_TYPES}`).all()
    : (() => {
        const ids = [...new Set(objectIds)];
        const placeholders = ids.map(() => '?').join(',');
        return database.prepare(`${select}
          WHERE r.ended_change_set_id IS NULL
            AND (r.from_object_type IN ${NETWORK_VISIBLE_ENDPOINT_TYPES} OR r.to_object_type IN ${NETWORK_VISIBLE_ENDPOINT_TYPES})
            AND (r.from_object_id IN (${placeholders}) OR r.to_object_id IN (${placeholders}))`).all(...ids, ...ids);
      })() as Array<Record<string, unknown>>;

  const versionIds = [...new Set(rows.flatMap((row) => {
    const ids: string[] = [];
    if (String(row.fromObjectType) === 'knowledge_note_version') ids.push(String(row.fromObjectId));
    if (String(row.toObjectType) === 'knowledge_note_version') ids.push(String(row.toObjectId));
    return ids;
  }))];
  const versionNoteMap = new Map<string, string>();
  if (versionIds.length) {
    const placeholders = versionIds.map(() => '?').join(',');
    for (const row of database.prepare(`SELECT id, note_id AS noteId FROM knowledge_note_versions WHERE id IN (${placeholders})`).all(...versionIds) as Array<Record<string, unknown>>) {
      versionNoteMap.set(String(row.id), String(row.noteId));
    }
  }
  const endpointNodeId = (objectType: string, objectId: string): string | null => {
    if (objectType === 'knowledge_note_version') {
      const noteId = versionNoteMap.get(objectId);
      return noteId ? knowledgeNetworkNodeId('knowledge_note', noteId) : null;
    }
    if (objectType === 'topic') return knowledgeNetworkNodeId('topic', objectId);
    if (objectType === 'knowledge_note') return knowledgeNetworkNodeId('knowledge_note', objectId);
    if (objectType === 'knowledge_entity') return knowledgeNetworkNodeId('knowledge_entity', objectId);
    return null;
  };
  const resolved: ResolvedNetworkRelation[] = [];
  for (const row of rows) {
    const from = endpointNodeId(String(row.fromObjectType), String(row.fromObjectId));
    const to = endpointNodeId(String(row.toObjectType), String(row.toObjectId));
    if (!from || !to) continue;
    resolved.push({ id: String(row.id), relationKey: String(row.relationKey), from, to, displayName: String(row.displayName ?? row.relationKey ?? '') });
  }
  return resolved;
}

/**
 * WMB-5255：派生采纳边稳定确定性 ID（与正式关系 ID 命名空间区分；同 note+dest 恒等）。
 */
function derivedAdoptionRelationId(noteId: string, destType: 'topic' | 'knowledge_entity', destId: string): string {
  return `derived:about:${noteId}:${destType}:${destId}`;
}

/**
 * WMB-5255：当前版本派生采纳关系（只读投影，不写表）。
 * 活动笔记 current_version 的 adoptedTopicIds/adoptedEntityIds → note -> 主题/实体 about 边；
 * 一次有界批量 UNION（json_each 展开当前版本 JSON，不触历史版本）。两端都必须落在
 * collectionNodeIds（≤2000 可见集合）：inactive/缺失目的地、集合外笔记一律不发射
 * （端点永不悬空）。relationType=about、displayName=registry 'about' 的 display_name（'关于'）。
 */
function resolveDerivedAdoptionRelations(database: DatabaseSync, collectionNodeIds: ReadonlySet<string>): ResolvedNetworkRelation[] {
  const noteIds = [...collectionNodeIds]
    .filter((id) => id.startsWith('knowledge_note:'))
    .map((id) => id.slice('knowledge_note:'.length));
  if (!noteIds.length) return [];
  const rows = database.prepare(`
    WITH collection_notes(id) AS (SELECT value FROM json_each(?))
    SELECT n.id AS noteId, 'topic' AS destType, j.value AS destId
    FROM collection_notes c JOIN knowledge_notes n ON n.id = c.id
      JOIN knowledge_note_versions v ON v.id = n.current_version_id,
      json_each(v.adopted_topic_ids_json) j
    WHERE n.lifecycle = 'active'
    UNION ALL
    SELECT n.id AS noteId, 'knowledge_entity' AS destType, j.value AS destId
    FROM collection_notes c JOIN knowledge_notes n ON n.id = c.id
      JOIN knowledge_note_versions v ON v.id = n.current_version_id,
      json_each(v.adopted_entity_ids_json) j
    WHERE n.lifecycle = 'active'`).all(JSON.stringify(noteIds)) as Array<Record<string, unknown>>;
  const resolved: ResolvedNetworkRelation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const noteId = String(row.noteId);
    const destType = String(row.destType) === 'topic' ? 'topic' : 'knowledge_entity';
    const destId = String(row.destId);
    if (!noteId || !destId) continue;
    const from = knowledgeNetworkNodeId('knowledge_note', noteId);
    const to = knowledgeNetworkNodeId(destType, destId);
    if (!collectionNodeIds.has(from) || !collectionNodeIds.has(to)) continue;
    const key = `${from}|${to}|about`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ id: derivedAdoptionRelationId(noteId, destType, destId), relationKey: 'about', from, to, displayName: '关于' });
  }
  return resolved;
}

/**
 * WMB-5255：合并可见关系集合 = 活动正式关系 + 当前版本派生采纳边。
 * 相同 from/to/relationType 时正式关系优先（正式身份/ID 保留，派生边不翻倍）；
 * 其余正式关系身份原样保留。
 */
function mergeNetworkRelations(formal: readonly ResolvedNetworkRelation[], derived: readonly ResolvedNetworkRelation[]): ResolvedNetworkRelation[] {
  const formalKeys = new Set<string>();
  for (const relation of formal) formalKeys.add(`${relation.from}|${relation.to}|${relation.relationKey}`);
  return [...formal, ...derived.filter((relation) => !formalKeys.has(`${relation.from}|${relation.to}|${relation.relationKey}`))];
}

/** 一批正式引用解析为网络节点（按正式对象批量查询；lifecycle/status 过滤；无 N+1）。 */
function resolveNetworkNodesBulk(database: DatabaseSync, refs: ReadonlyArray<{ objectType: KnowledgeNetworkNodeType; objectId: string }>): Map<string, KnowledgeNetworkNode> {
  const map = new Map<string, KnowledgeNetworkNode>();
  const topics = [...new Set(refs.filter((ref) => ref.objectType === 'topic').map((ref) => ref.objectId))];
  const notes = [...new Set(refs.filter((ref) => ref.objectType === 'knowledge_note').map((ref) => ref.objectId))];
  const entities = [...new Set(refs.filter((ref) => ref.objectType === 'knowledge_entity').map((ref) => ref.objectId))];
  const push = (objectType: KnowledgeNetworkNodeType, objectId: string, shortTitle: string, summary: string, updatedAt: string) => {
    const id = knowledgeNetworkNodeId(objectType, objectId);
    map.set(id, { id, objectType, objectId, shortTitle, summary, weight: 0, updatedAt });
  };
  if (topics.length) {
    const rows = database.prepare(`SELECT id, title AS shortTitle, coalesce(summary,'') AS summary, updated_at AS updatedAt
      FROM topics WHERE id IN (${topics.map(() => '?').join(',')}) AND status != 'archived'`).all(...topics) as Array<Record<string, unknown>>;
    for (const row of rows) push('topic', String(row.id), String(row.shortTitle ?? ''), String(row.summary ?? ''), String(row.updatedAt ?? ''));
  }
  if (notes.length) {
    const rows = database.prepare(`SELECT n.id, n.title AS shortTitle, coalesce(v.statement,'') AS summary, n.updated_at AS updatedAt
      FROM knowledge_notes n LEFT JOIN knowledge_note_versions v ON v.id = n.current_version_id
      WHERE n.id IN (${notes.map(() => '?').join(',')}) AND n.lifecycle = 'active'`).all(...notes) as Array<Record<string, unknown>>;
    for (const row of rows) push('knowledge_note', String(row.id), String(row.shortTitle ?? ''), String(row.summary ?? ''), String(row.updatedAt ?? ''));
  }
  if (entities.length) {
    const rows = database.prepare(`SELECT id, canonical_name AS shortTitle, updated_at AS updatedAt
      FROM knowledge_entities WHERE id IN (${entities.map(() => '?').join(',')}) AND lifecycle = 'active'`).all(...entities) as Array<Record<string, unknown>>;
    for (const row of rows) push('knowledge_entity', String(row.id), String(row.shortTitle ?? ''), '', String(row.updatedAt ?? ''));
  }
  return map;
}

/**
 * WMB-5243/WMB-5255：全局 Wiki 知识网络只读投影。分页有界（limit 默认 500 / 上限 2000，offset 分页）；
 * 节点 = topic/knowledge_note/knowledge_entity 正式对象（短标题 + 知识摘要来自既有正式字段）；
 * 关系 = 合并可见关系集合（活动正式知识关系 + 当前版本派生采纳 about 边；正式同
 * from/to/relationType 优先去重；两端映射到投影节点集合 ≤2000；跨页关系不丢失，每页返回同一集合关系）；
 * filters = 可用类型及关系分组（合并可见集合口径，不受本页 limit/offset 影响）；无第二真源。
 */
export function getKnowledgeNetworkProjection(database: DatabaseSync, rawInput: KnowledgeNetworkProjectionInput = {}): KnowledgeNetworkProjection {
  const input = rawInput ?? {};
  const nodeTypes = (input.nodeTypes ?? KNOWLEDGE_NETWORK_DEFAULT_NODE_TYPES).filter(
    (type): type is KnowledgeNetworkNodeType => type === 'topic' || type === 'knowledge_note' || type === 'knowledge_entity');
  if (!nodeTypes.length) throw new Error('NETWORK_NODE_TYPES_REQUIRED');
  const limit = Math.min(Math.max(input.limit ?? KNOWLEDGE_NETWORK_DEFAULT_LIMIT, 1), KNOWLEDGE_NETWORK_MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);
  const relationKeySet = input.relationKeys ? new Set([...new Set(input.relationKeys)].filter(Boolean)) : null;

  const union = networkNodesUnion(nodeTypes);
  const countRow = database.prepare(`SELECT count(*) AS count, coalesce(max(updatedAt),'') AS updatedAt FROM (${union})`).get() as { count: number; updatedAt: string };
  const totalNodes = Number(countRow.count);
  const nodeRows = database.prepare(`${union} ORDER BY updatedAt DESC, objectType, objectId LIMIT ? OFFSET ?`).all(limit, offset) as Array<Record<string, unknown>>;

  // 集合级关系：投影合同节点上限 = KNOWLEDGE_NETWORK_MAX_LIMIT（2000），一次取得完整节点集合
  // （与分页同排序；渲染端合并上限一致），关系只要求两端都在该集合内 —— 端点落在分页边界两侧
  // 的正式关系不因分页丢失；每页返回同一集合关系（渲染合并按 id 去重），端点永不悬空。
  const collectionRows = database.prepare(`${union} ORDER BY updatedAt DESC, objectType, objectId LIMIT ?`).all(KNOWLEDGE_NETWORK_MAX_LIMIT) as Array<Record<string, unknown>>;
  const collectionNodeIds = new Set(collectionRows.map((row) => knowledgeNetworkNodeId(row.objectType as KnowledgeNetworkNodeType, String(row.objectId))));

  // WMB-5255：合并可见关系集合 = 活动正式关系 + 当前版本派生采纳边
  // （正式同 from/to/relationType 优先去重；两端均在 ≤2000 投影节点集合内，跨页不丢失）。
  const visibleRelations = mergeNetworkRelations(
    resolveActiveNetworkRelations(database, null),
    resolveDerivedAdoptionRelations(database, collectionNodeIds)
  ).filter((relation) => collectionNodeIds.has(relation.from) && collectionNodeIds.has(relation.to));
  const degreeByNode = new Map<string, number>();
  for (const relation of visibleRelations) {
    degreeByNode.set(relation.from, (degreeByNode.get(relation.from) ?? 0) + 1);
    degreeByNode.set(relation.to, (degreeByNode.get(relation.to) ?? 0) + 1);
  }
  const nodes = nodeRows.map((row) => {
    const objectType = row.objectType as KnowledgeNetworkNodeType;
    const objectId = String(row.objectId);
    const id = knowledgeNetworkNodeId(objectType, objectId);
    return {
      id, objectType, objectId,
      shortTitle: String(row.shortTitle ?? ''),
      summary: String(row.summary ?? ''),
      weight: degreeByNode.get(id) ?? 0,
      updatedAt: String(row.updatedAt ?? '')
    } satisfies KnowledgeNetworkNode;
  });

  // 关系：relationKeys 过滤；集合级关系每页返回同一集合（渲染合并按 id 去重；端点永不悬空）。
  const relations = visibleRelations
    .filter((relation) => !relationKeySet || relationKeySet.has(relation.relationKey))
    .map((relation) => ({ id: relation.id, from: relation.from, to: relation.to, relationType: relation.relationKey, displayName: relation.displayName }));

  // filters：合并可见集合口径（不受本页 limit/offset 影响；relationKeys 过滤时仍展示全量可选分组）。
  const typeCountRows = database.prepare(`SELECT objectType, count(*) AS count FROM (${networkNodesUnion(KNOWLEDGE_NETWORK_DEFAULT_NODE_TYPES)}) GROUP BY objectType`).all() as Array<Record<string, unknown>>;
  const typeCounts = new Map(typeCountRows.map((row) => [String(row.objectType), Number(row.count)]));
  const nodeTypeFilters = KNOWLEDGE_NETWORK_DEFAULT_NODE_TYPES
    .map((type) => ({ id: type, label: KNOWLEDGE_NETWORK_NODE_TYPE_LABELS[type], count: typeCounts.get(type) ?? 0 }))
    .filter((entry) => entry.count > 0);
  const registryRows = database.prepare(`SELECT relation_key AS relationKey, display_name AS displayName FROM knowledge_relation_registry`).all() as Array<Record<string, unknown>>;
  const displayByKey = new Map(registryRows.map((row) => [String(row.relationKey), String(row.displayName)]));
  const relationTypeCounts = new Map<string, number>();
  for (const relation of visibleRelations) {
    relationTypeCounts.set(relation.relationKey, (relationTypeCounts.get(relation.relationKey) ?? 0) + 1);
  }
  const relationTypeFilters = [...relationTypeCounts.entries()]
    .map(([key, count]) => ({ id: key, label: displayByKey.get(key) ?? key, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const totalRelations = relationKeySet
    ? visibleRelations.filter((relation) => relationKeySet.has(relation.relationKey)).length
    : visibleRelations.length;
  const maxRelationCreatedAt = String((database.prepare(`SELECT coalesce(max(created_at),'') AS maxCreatedAt FROM knowledge_formal_relations WHERE ended_change_set_id IS NULL`).get() as { maxCreatedAt: string }).maxCreatedAt ?? '');
  // WMB-5255：版本采纳变化也要刷新投影时间戳（新版本 created_at 可能晚于笔记 updated_at 的写路径）。
  const maxVersionCreatedAt = String((database.prepare(`SELECT coalesce(max(v.created_at),'') AS maxCreatedAt
    FROM knowledge_notes n JOIN knowledge_note_versions v ON v.id = n.current_version_id
    WHERE n.lifecycle = 'active'`).get() as { maxCreatedAt: string }).maxCreatedAt ?? '');
  const updatedAt = [String(countRow.updatedAt ?? ''), maxRelationCreatedAt, maxVersionCreatedAt].filter(Boolean).sort().pop() ?? '';

  return {
    networkId: 'global', nodes, relations,
    filters: { nodeTypes: nodeTypeFilters, relationTypes: relationTypeFilters },
    totalNodes, totalRelations, limit, offset,
    hasMore: offset + nodes.length < totalNodes, updatedAt
  };
}

// ===== 知识本体详情（知识卡片第一屏字段） =====

/** 证据边界统计（关系/来源性质分布；全部证据行口径，摘要列表另行有界）。 */
function collectEvidenceBoundary(rows: readonly Record<string, unknown>[]): KnowledgeNetworkNodeDetail['knowledge']['evidenceBoundary'] {
  const byRelation: Record<string, number> = {};
  const bySourceNature: Record<string, number> = {};
  for (const row of rows) {
    const relation = String(row.relation ?? '');
    const sourceNature = String(row.sourceNature ?? '');
    if (relation) byRelation[relation] = (byRelation[relation] ?? 0) + 1;
    if (sourceNature) bySourceNature[sourceNature] = (bySourceNature[sourceNature] ?? 0) + 1;
  }
  return { evidenceCount: rows.length, byRelation, bySourceNature };
}

/** 证据摘要有界列表；source 标题一批解析（其余对象类型诚实为 null）。 */
function evidenceEntries(database: DatabaseSync, rows: readonly Record<string, unknown>[], limit: number): KnowledgeNetworkEvidenceEntry[] {
  // 局部可变条目类型：sourceTitle 需后置批量回填，最终按共享契约（readonly）边界返回。
  type MutableEvidenceEntry = { relation: string; sourceNature: string; excerpt: string | null; locator: string | null; sourceTitle: string | null };
  const items: MutableEvidenceEntry[] = rows.slice(0, limit).map((row) => ({
    relation: String(row.relation ?? ''),
    sourceNature: String(row.sourceNature ?? ''),
    excerpt: (row.excerpt as string | null) ?? null,
    locator: (row.locator as string | null) ?? null,
    sourceTitle: null
  }));
  const sourceIds = [...new Set(rows.slice(0, limit)
    .filter((row) => String(row.evidenceObjectType) === 'source')
    .map((row) => String(row.evidenceObjectId)))];
  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const titles = new Map((database.prepare(`SELECT id, title FROM source_items WHERE id IN (${placeholders})`).all(...sourceIds) as Array<Record<string, unknown>>)
      .map((row) => [String(row.id), String(row.title ?? '')]));
    rows.slice(0, limit).forEach((row, index) => {
      if (String(row.evidenceObjectType) === 'source') items[index].sourceTitle = titles.get(String(row.evidenceObjectId)) ?? null;
    });
  }
  return items as unknown as KnowledgeNetworkEvidenceEntry[];
}

function dedupeRelated(entries: KnowledgeNetworkRelatedEntry[], limit: number): KnowledgeNetworkRelatedEntry[] {
  const seen = new Set<string>();
  const result: KnowledgeNetworkRelatedEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.nodeId)) continue;
    seen.add(entry.nodeId);
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

/** 相关认识：正式关系另一端点（端点解析到可见节点；knowledge_note_version 端点映射到其笔记）。 */
function pushRelationEndpoints(database: DatabaseSync, node: KnowledgeNetworkNode, entries: KnowledgeNetworkRelatedEntry[]) {
  const objectIds = [node.objectId];
  if (node.objectType === 'knowledge_note') {
    const row = database.prepare('SELECT current_version_id AS versionId FROM knowledge_notes WHERE id = ?').get(node.objectId) as { versionId: string | null } | undefined;
    if (row?.versionId) objectIds.push(row.versionId);
  }
  const relations = resolveActiveNetworkRelations(database, objectIds);
  const firstByEndpoint = new Map<string, ResolvedNetworkRelation>();
  for (const relation of relations) {
    const other = relation.from === node.id ? relation.to : relation.from;
    if (!firstByEndpoint.has(other)) firstByEndpoint.set(other, relation);
  }
  const refs: Array<{ objectType: KnowledgeNetworkNodeType; objectId: string }> = [];
  for (const other of firstByEndpoint.keys()) {
    const parsed = parseKnowledgeNetworkNodeId(other);
    if (parsed) refs.push(parsed);
  }
  const endpointNodes = resolveNetworkNodesBulk(database, refs);
  for (const [other, relation] of firstByEndpoint) {
    const endpoint = endpointNodes.get(other);
    if (!endpoint) continue;
    entries.push({ nodeId: endpoint.id, objectType: endpoint.objectType, objectId: endpoint.objectId, title: endpoint.shortTitle, relationKey: relation.relationKey });
  }
}

/** 实体/主题的 wiki 当前版本固定引用（无正式页面 → null；精简 fixture 缺表 → null）。 */
function wikiVersionRefFor(database: DatabaseSync, subjectType: 'topic' | 'entity', objectType: KnowledgeNetworkNodeType, subjectId: string): KnowledgeNetworkVersionRef | null {
  try {
    const page = database.prepare(`SELECT id FROM knowledge_wiki_pages WHERE subject_type=? AND subject_id=? AND lifecycle='active' ORDER BY updated_at DESC LIMIT 1`).get(subjectType, subjectId) as { id: string } | undefined;
    if (!page) return null;
    const detail = getWikiPage(database, page.id);
    if (!detail?.version) return null;
    return { versionKind: 'wiki_page_version', versionId: detail.version.id, objectType, objectId: subjectId, createdAt: detail.version.createdAt };
  } catch {
    return null; // 精简 fixture 缺 v56 表
  }
}

const NETWORK_EVIDENCE_SELECT = `SELECT el.id, el.evidence_object_type AS evidenceObjectType, el.evidence_object_id AS evidenceObjectId,
  el.relation, el.source_nature AS sourceNature, el.excerpt, el.locator, el.created_at AS createdAt
  FROM knowledge_evidence_links el`;

type NetworkKnowledgeBundle = {
  knowledge: KnowledgeNetworkNodeDetail['knowledge'];
  versionRef: KnowledgeNetworkVersionRef | null;
};

function topicKnowledgeBundle(database: DatabaseSync, node: KnowledgeNetworkNode): NetworkKnowledgeBundle {
  const evidenceRows = database.prepare(`${NETWORK_EVIDENCE_SELECT} JOIN knowledge_note_versions v ON v.id = el.knowledge_note_version_id,
    json_each(v.adopted_topic_ids_json) j WHERE j.value = ? ORDER BY el.created_at DESC, el.id DESC`).all(node.objectId) as Array<Record<string, unknown>>;
  const entries: KnowledgeNetworkRelatedEntry[] = [];
  const adopted = database.prepare(`SELECT DISTINCT n.id, n.title, n.updated_at AS updatedAt FROM knowledge_note_versions v
    JOIN knowledge_notes n ON n.id = v.note_id, json_each(v.adopted_topic_ids_json) j
    WHERE j.value = ? AND n.lifecycle = 'active' ORDER BY n.updated_at DESC, n.id LIMIT ?`).all(node.objectId, NETWORK_DETAIL_RELATED_LIMIT) as Array<Record<string, unknown>>;
  for (const row of adopted) {
    entries.push({ nodeId: knowledgeNetworkNodeId('knowledge_note', String(row.id)), objectType: 'knowledge_note', objectId: String(row.id), title: String(row.title ?? ''), relationKey: 'about' });
  }
  pushRelationEndpoints(database, node, entries);
  return {
    knowledge: {
      primary: node.summary,
      scope: '',
      evidenceBoundary: collectEvidenceBoundary(evidenceRows),
      evidenceSummary: evidenceEntries(database, evidenceRows, NETWORK_DETAIL_EVIDENCE_LIMIT),
      related: dedupeRelated(entries, NETWORK_DETAIL_RELATED_LIMIT),
      updatedAt: node.updatedAt
    },
    versionRef: wikiVersionRefFor(database, 'topic', 'topic', node.objectId)
  };
}

function noteKnowledgeBundle(database: DatabaseSync, node: KnowledgeNetworkNode): NetworkKnowledgeBundle {
  const row = database.prepare(`SELECT v.id AS versionId, v.statement, v.applies_to AS appliesTo, v.created_at AS createdAt
    FROM knowledge_notes n LEFT JOIN knowledge_note_versions v ON v.id = n.current_version_id WHERE n.id = ?`).get(node.objectId) as Record<string, unknown> | undefined;
  const versionId = row?.versionId ? String(row.versionId) : null;
  const evidenceRows = versionId
    ? database.prepare(`${NETWORK_EVIDENCE_SELECT} WHERE el.knowledge_note_version_id = ? ORDER BY el.created_at DESC, el.id DESC`).all(versionId) as Array<Record<string, unknown>>
    : [];
  const entries: KnowledgeNetworkRelatedEntry[] = [];
  if (versionId) {
    const adoptedEntityIds = (database.prepare(`SELECT j.value AS id FROM knowledge_note_versions v, json_each(v.adopted_entity_ids_json) j WHERE v.id = ?`).all(versionId) as Array<Record<string, unknown>>).map((item) => String(item.id));
    const adoptedTopicIds = (database.prepare(`SELECT j.value AS id FROM knowledge_note_versions v, json_each(v.adopted_topic_ids_json) j WHERE v.id = ?`).all(versionId) as Array<Record<string, unknown>>).map((item) => String(item.id));
    const adoptedNodes = resolveNetworkNodesBulk(database, [
      ...adoptedEntityIds.map((objectId) => ({ objectType: 'knowledge_entity' as const, objectId })),
      ...adoptedTopicIds.map((objectId) => ({ objectType: 'topic' as const, objectId }))
    ]);
    for (const adoptedNode of adoptedNodes.values()) {
      entries.push({ nodeId: adoptedNode.id, objectType: adoptedNode.objectType, objectId: adoptedNode.objectId, title: adoptedNode.shortTitle, relationKey: 'about' });
    }
  }
  pushRelationEndpoints(database, node, entries);
  return {
    knowledge: {
      primary: row?.statement ? String(row.statement) : node.summary,
      scope: row?.appliesTo ? String(row.appliesTo) : '',
      evidenceBoundary: collectEvidenceBoundary(evidenceRows),
      evidenceSummary: evidenceEntries(database, evidenceRows, NETWORK_DETAIL_EVIDENCE_LIMIT),
      related: dedupeRelated(entries, NETWORK_DETAIL_RELATED_LIMIT),
      updatedAt: node.updatedAt
    },
    versionRef: versionId ? { versionKind: 'note_version', versionId, objectType: node.objectType, objectId: node.objectId, createdAt: String(row?.createdAt ?? '') } : null
  };
}

function entityKnowledgeBundle(database: DatabaseSync, node: KnowledgeNetworkNode): NetworkKnowledgeBundle {
  // 实体核心说明：entity 主题 wiki 页正文 summary（诚实）；无正文 → canonical_name 诚实回退。
  let primary = node.shortTitle;
  let wikiPageId: string | null = null;
  try {
    const page = database.prepare(`SELECT id FROM knowledge_wiki_pages WHERE subject_type='entity' AND subject_id=? AND lifecycle='active' ORDER BY updated_at DESC LIMIT 1`).get(node.objectId) as { id: string } | undefined;
    wikiPageId = page?.id ?? null;
    if (wikiPageId) {
      const detail = getWikiPage(database, wikiPageId);
      const body = detail?.version?.body;
      if (body && typeof body === 'object') {
        const summary = String((body as Record<string, unknown>).summary ?? '').trim();
        if (summary) primary = summary;
      }
    }
  } catch {
    // 精简 fixture 缺 v56 表 → 无 wiki 页
  }
  const evidenceRows = database.prepare(`${NETWORK_EVIDENCE_SELECT} JOIN knowledge_note_versions v ON v.id = el.knowledge_note_version_id,
    json_each(v.adopted_entity_ids_json) j WHERE j.value = ? ORDER BY el.created_at DESC, el.id DESC`).all(node.objectId) as Array<Record<string, unknown>>;
  const entries: KnowledgeNetworkRelatedEntry[] = [];
  const adopted = database.prepare(`SELECT DISTINCT n.id, n.title, n.updated_at AS updatedAt FROM knowledge_note_versions v
    JOIN knowledge_notes n ON n.id = v.note_id, json_each(v.adopted_entity_ids_json) j
    WHERE j.value = ? AND n.lifecycle = 'active' ORDER BY n.updated_at DESC, n.id LIMIT ?`).all(node.objectId, NETWORK_DETAIL_RELATED_LIMIT) as Array<Record<string, unknown>>;
  for (const row of adopted) {
    entries.push({ nodeId: knowledgeNetworkNodeId('knowledge_note', String(row.id)), objectType: 'knowledge_note', objectId: String(row.id), title: String(row.title ?? ''), relationKey: 'about' });
  }
  pushRelationEndpoints(database, node, entries);
  let versionRef: KnowledgeNetworkVersionRef | null = null;
  if (wikiPageId) {
    try {
      const detail = getWikiPage(database, wikiPageId);
      if (detail?.version) versionRef = { versionKind: 'wiki_page_version', versionId: detail.version.id, objectType: node.objectType, objectId: node.objectId, createdAt: detail.version.createdAt };
    } catch {
      // 精简 fixture
    }
  }
  return {
    knowledge: {
      primary, scope: '',
      evidenceBoundary: collectEvidenceBoundary(evidenceRows),
      evidenceSummary: evidenceEntries(database, evidenceRows, NETWORK_DETAIL_EVIDENCE_LIMIT),
      related: dedupeRelated(entries, NETWORK_DETAIL_RELATED_LIMIT),
      updatedAt: node.updatedAt
    },
    versionRef
  };
}

function networkNodeKnowledge(database: DatabaseSync, node: KnowledgeNetworkNode): NetworkKnowledgeBundle {
  if (node.objectType === 'topic') return topicKnowledgeBundle(database, node);
  if (node.objectType === 'knowledge_note') return noteKnowledgeBundle(database, node);
  return entityKnowledgeBundle(database, node);
}

function networkNodeDeepLink(node: KnowledgeNetworkNode): KnowledgeNetworkNodeDetail['deepLink'] {
  return { route: node.objectType === 'topic' ? 'topic' : 'object', objectType: node.objectType, objectId: node.objectId, title: node.shortTitle };
}

/**
 * WMB-5243：节点知识本体详情（知识卡片第一屏：完整认识/适用范围/证据边界/依据摘要/相关认识/
 * 最近更新时间；对象 ID/表名/ChangeSet/编译状态不进入第一屏）。nodeId 为稳定网络节点 ID。
 */
export function getKnowledgeNetworkNodeDetail(database: DatabaseSync, rawInput: KnowledgeNetworkNodeDetailInput): KnowledgeNetworkNodeDetail {
  const input = rawInput ?? {};
  const parsed = parseKnowledgeNetworkNodeId(String(input.nodeId ?? ''));
  if (!parsed) throw new Error('NETWORK_NODE_NOT_FOUND');
  const node = resolveNetworkNodesBulk(database, [{ objectType: parsed.objectType, objectId: parsed.objectId }]).get(knowledgeNetworkNodeId(parsed.objectType, parsed.objectId)) ?? null;
  if (!node) throw new Error('NETWORK_NODE_NOT_FOUND');
  // 位置权重 = 该对象相关活动正式关系度数（知识本体关联同一关系源；note 含当前版本端点）。
  const objectIds = [parsed.objectId];
  if (parsed.objectType === 'knowledge_note') {
    const row = database.prepare('SELECT current_version_id AS versionId FROM knowledge_notes WHERE id = ?').get(parsed.objectId) as { versionId: string | null } | undefined;
    if (row?.versionId) objectIds.push(row.versionId);
  }
  const relations = resolveActiveNetworkRelations(database, objectIds);
  const nodeId = node.id;
  const withWeight = { ...node, weight: relations.filter((relation) => relation.from === nodeId || relation.to === nodeId).length };
  const bundle = networkNodeKnowledge(database, withWeight);
  return { node: withWeight, knowledge: bundle.knowledge, versionRef: bundle.versionRef, deepLink: networkNodeDeepLink(withWeight) };
}

// ===== 冻结选择包（canvasId='global'；复用既有 preview/清单通道，PiDock 不变） =====

/** 自动展开的冻结知识正文包（不是节点名称清单；Pi 获得正文/适用范围/证据边界/摘要/固定版本引用）。 */
type FrozenKnowledgeContent = Readonly<{
  coreStatement: string;
  appliesTo: string;
  evidenceBoundary: Readonly<{ evidenceCount: number; byRelation: Readonly<Record<string, number>>; bySourceNature: Readonly<Record<string, number>> }>;
  evidenceSummary: string;
  versionRef: Readonly<{ versionKind: 'note_version' | 'wiki_page_version'; versionId: string; createdAt: string }> | null;
}>;

type GlobalSelectionExcluded = { kind: 'object'; id: string; objectType: string | null; reason: 'duplicate' | 'invalid' | 'over_limit' };

/** 未纳入明细有界上限（excludedReasons 只带前 N 条；excludedCount 恒为全量）。 */
const SELECTION_EXCLUDED_REASONS_LIMIT = 20;

function formatEvidenceSummary(entries: readonly KnowledgeNetworkEvidenceEntry[]): string {
  return entries
    .map((entry) => entry.excerpt ? `[${entry.relation}@${entry.sourceNature}]${entry.sourceTitle ? `（${entry.sourceTitle}）` : ''} ${entry.excerpt}` : null)
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

/**
 * 全局网络冻结选择包：解析稳定节点 ID（工作空间校验：无效/已消失节点不中断清单，
 * 进 excluded(reason=invalid) 并在 excludedCount 明示）→ 按正式知识身份去重 →
 * 自动展开冻结正文 → 有界字符（按知识优先级 + 选中顺序裁剪，未纳入项进 excluded
 * 并带 reason；不得静默换成全图）。全部未纳入项（invalid + duplicate + over_limit）
 * 计入 manifest.excludedCount，excludedReasons 提供有界明细；全部无效时无内容可冻结。
 */
function buildGlobalSelection(database: DatabaseSync, nodeIds: string[]): { manifest: KnowledgeCanvasSelectionManifest; excluded: GlobalSelectionExcluded[] } {
  if (!nodeIds.length) throw new Error('PACKAGE_ITEMS_REQUIRED');
  const refs: Array<{ objectType: KnowledgeNetworkNodeType; objectId: string }> = [];
  for (const nodeId of nodeIds) {
    const parsed = parseKnowledgeNetworkNodeId(nodeId);
    if (parsed) refs.push(parsed);
  }
  const nodes = resolveNetworkNodesBulk(database, refs);
  const resolved: Array<{ nodeId: string; objectType: string; objectId: string; title: string; content: FrozenKnowledgeContent }> = [];
  const excluded: GlobalSelectionExcluded[] = [];
  for (const nodeId of nodeIds) {
    const parsed = parseKnowledgeNetworkNodeId(nodeId);
    if (!parsed) {
      excluded.push({ kind: 'object', id: nodeId, objectType: null, reason: 'invalid' });
      continue;
    }
    const node = nodes.get(nodeId);
    if (!node) {
      excluded.push({ kind: 'object', id: nodeId, objectType: parsed.objectType, reason: 'invalid' });
      continue;
    }
    const bundle = networkNodeKnowledge(database, node);
    resolved.push({
      nodeId: node.id,
      objectType: node.objectType,
      objectId: node.objectId,
      title: node.shortTitle,
      content: {
        coreStatement: bundle.knowledge.primary,
        appliesTo: bundle.knowledge.scope,
        evidenceBoundary: bundle.knowledge.evidenceBoundary,
        evidenceSummary: formatEvidenceSummary(bundle.knowledge.evidenceSummary),
        versionRef: bundle.versionRef ? { versionKind: bundle.versionRef.versionKind, versionId: bundle.versionRef.versionId, createdAt: bundle.versionRef.createdAt } : null
      }
    });
  }
  // 去重：稳定节点 ID = 正式知识身份（重复选中只保留一份）。
  const seen = new Set<string>();
  const unique: typeof resolved = [];
  for (const item of resolved) {
    if (seen.has(item.nodeId)) {
      excluded.push({ kind: 'object', id: item.nodeId, objectType: item.objectType, reason: 'duplicate' });
      continue;
    }
    seen.add(item.nodeId);
    unique.push(item);
  }
  // 有界字符：按知识优先级（topic > note > entity）贪心容纳；同级保持选中顺序（稳定排序）。
  const ordered = [...unique].sort((a, b) => NETWORK_NODE_PRIORITY[a.objectType] - NETWORK_NODE_PRIORITY[b.objectType]);
  const items: Array<{ nodeId: string; objectType: string; objectId: string | null; title: string; snapshot: Readonly<Record<string, unknown>> | null }> = [];
  let accumulated = 0;
  const limitCharacters = KNOWLEDGE_PACKAGE_CHARACTER_LIMIT;
  for (const item of ordered) {
    const itemChars = JSON.stringify({ snapshot: item.content }).length;
    if (items.length && accumulated + itemChars > limitCharacters) {
      excluded.push({ kind: 'object', id: item.nodeId, objectType: item.objectType, reason: 'over_limit' });
      continue;
    }
    items.push({ nodeId: item.nodeId, objectType: item.objectType, objectId: item.objectId, title: item.title, snapshot: item.content as unknown as Readonly<Record<string, unknown>> });
    accumulated += itemChars;
  }
  if (!items.length) throw new Error('PACKAGE_ITEMS_REQUIRED');
  const manifest: KnowledgeCanvasSelectionManifest = {
    scope: 'selected_only', canvasId: KNOWLEDGE_NETWORK_CANVAS_ID, items,
    excludedCount: excluded.length,
    excludedReasons: excluded.slice(0, SELECTION_EXCLUDED_REASONS_LIMIT).map((entry) => ({
      nodeId: entry.id, objectType: entry.objectType, reason: entry.reason
    })),
    estimatedCharacters: JSON.stringify({ items }).length,
    limitCharacters, overLimit: JSON.stringify({ items }).length > limitCharacters
  };
  return { manifest, excluded };
}

/** 全局网络预览包（previewKnowledgeContextPackage 的 canvasId='global' 分支；与清单同源）。 */
function previewGlobalKnowledgeContextPackage(database: DatabaseSync, input: {
  canvasId: string; nodeIds: string[]; excludedNodeIds?: string[]; excludedRelationIds?: string[];
}) {
  const { manifest, excluded: selectionExcluded } = buildGlobalSelection(database, input.nodeIds);
  const excludedNodeIds = new Set(input.excludedNodeIds ?? []);
  const excludedRelationIds = new Set(input.excludedRelationIds ?? []);
  const selected = manifest.items.filter((item) => !excludedNodeIds.has(item.nodeId));
  if (!selected.length) throw new Error('PACKAGE_ITEMS_REQUIRED');
  const selectedSet = new Set(selected.map((item) => item.nodeId));
  // 正式关系：两端都在选中集合（knowledge_note_version 端点解析到其笔记）。
  const relations = resolveActiveNetworkRelations(database, null)
    .filter((relation) => selectedSet.has(relation.from) && selectedSet.has(relation.to) && !excludedRelationIds.has(relation.id))
    .map((relation) => ({
      id: relation.id, fromNodeId: relation.from, toNodeId: relation.to, relationType: relation.relationKey,
      label: relation.displayName, state: 'active', hidden: 0, createdBy: 'formal', revision: 1
    }));
  const items = selected.map((item, index) => ({ nodeId: item.nodeId, objectType: item.objectType, objectId: item.objectId ?? null, sortOrder: index, snapshot: item.snapshot }));
  const excluded = [
    ...selectionExcluded,
    ...manifest.items.filter((item) => excludedNodeIds.has(item.nodeId)).map((item) => ({ kind: 'object', id: item.nodeId, objectType: item.objectType, reason: 'user_excluded' }))
  ];
  const estimatedCharacters = JSON.stringify({ items, relations }).length;
  return {
    scope: 'selected_only', items, relations, excluded, excludedCount: excluded.length, truncated: false,
    estimatedCharacters, limitCharacters: KNOWLEDGE_PACKAGE_CHARACTER_LIMIT,
    overLimit: estimatedCharacters > KNOWLEDGE_PACKAGE_CHARACTER_LIMIT
  };
}

