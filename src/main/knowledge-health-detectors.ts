// extracted from src/main/knowledge-health.ts (structural split)
import type { DatabaseSync } from 'node:sqlite';
import type { HealthIssueType, KnowledgeScope } from './knowledge-flywheel.ts';
import {
  DATA_GAP_FREE_NOTE_MAX_AGE_DAYS,
  EVIDENCE_OBJECT_TABLES,
  ENDPOINT_TABLES,
  WIKI_REF_TABLES,
  dataGapCutoffIso,
  objectExists,
} from './knowledge-health-types.ts';
import type {
  HealthLintDetector,
  HealthLintIssuePlan,
} from './knowledge-health-types.ts';

// ============================================================
// 检测器（只读；scope 内过滤）
// ============================================================

export type DetectorContext = Readonly<{
  database: DatabaseSync;
  workspaceId: string;
  scope: KnowledgeScope;
  detectors: readonly HealthLintDetector[];
}>;

/** 有界读：活动关系分页行。 */
export function listActiveRelationRows(
  database: DatabaseSync,
  scope: KnowledgeScope,
  cursor: string,
  limit: number
): Array<Record<string, unknown>> {
  const scopeValue: string = scope;
  return database.prepare(
    `SELECT id, scope, relation_key AS relationKey, from_object_type AS fromObjectType, from_object_id AS fromObjectId,
       to_object_type AS toObjectType, to_object_id AS toObjectId
     FROM knowledge_formal_relations
     WHERE ended_change_set_id IS NULL AND scope = ? AND id > ?
     ORDER BY id LIMIT ?`
  ).all(scopeValue, cursor, limit) as Array<Record<string, unknown>>;
}

export function relationGhostEndpoints(database: DatabaseSync, row: Record<string, unknown>): Array<{ type: string; id: string }> {
  const ghosts: Array<{ type: string; id: string }> = [];
  const pairs: Array<[string, string]> = [
    [String(row.fromObjectType), String(row.fromObjectId)],
    [String(row.toObjectType), String(row.toObjectId)]
  ];
  for (const [type, id] of pairs) {
    const table = ENDPOINT_TABLES[type];
    if (!table) continue;
    if (!objectExists(database, table, id)) ghosts.push({ type, id });
  }
  return ghosts;
}

export function brokenRelationPlan(ctx: DetectorContext, row: Record<string, unknown>): HealthLintIssuePlan | null {
  if (String(row.scope) !== ctx.scope) return null; // lane 隔离：不越 scope 检查
  const ghosts = relationGhostEndpoints(ctx.database, row);
  if (!ghosts.length) return null;
  const relationId = String(row.id);
  return Object.freeze({
    issueType: 'broken_reference',
    affectedObjectType: 'knowledge_relation',
    affectedObjectId: relationId,
    severity: 'high',
    anchor: `relation:${relationId}:${String(row.fromObjectType)}:${String(row.fromObjectId)}->${String(row.toObjectType)}:${String(row.toObjectId)}`,
    detail: `活动关系 ${String(row.relationKey)} 端点不存在：${ghosts.map((g) => `${g.type}:${g.id}`).join('、')}。`,
    suggestedAction: '确定性修复：自动终止该关系。',
    autoRepair: Object.freeze({ kind: 'end_relation' as const, relationId })
  });
}

/** 有界读：证据链接分页行（按 Note 的 scope 过滤；证据链接本身无 scope 列）。 */
export function listEvidenceLinkRows(
  database: DatabaseSync,
  scope: KnowledgeScope,
  cursor: string,
  limit: number
): Array<Record<string, unknown>> {
  return database.prepare(
    `SELECT e.id, e.knowledge_note_version_id AS noteVersionId, e.evidence_object_type AS evidenceObjectType,
       e.evidence_object_id AS evidenceObjectId
     FROM knowledge_evidence_links e
     JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
     JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.scope = ? AND e.id > ?
     ORDER BY e.id LIMIT ?`
  ).all(scope, cursor, limit) as Array<Record<string, unknown>>;
}

export function brokenEvidencePlan(ctx: DetectorContext, row: Record<string, unknown>): HealthLintIssuePlan | null {
  const type = String(row.evidenceObjectType);
  const id = String(row.evidenceObjectId);
  const table = EVIDENCE_OBJECT_TABLES[type];
  if (!table) return null;
  if (objectExists(ctx.database, table, id)) return null;
  const linkId = String(row.id);
  const noteVersionId = String(row.noteVersionId);
  return Object.freeze({
    issueType: 'broken_reference',
    affectedObjectType: 'knowledge_note_version',
    affectedObjectId: noteVersionId,
    severity: 'medium',
    anchor: `evidence:${linkId}:${type}:${id}`,
    detail: `证据链接 ${linkId} 指向不存在的 ${type}:${id}（源对象已被删除）。`,
    suggestedAction: '证据链接不可变不可删除；请人工更新 Note 版本或接受风险。'
  });
}

/** outcome 回流检测键（与 ImplementOutcomeFeedback 约定：`outcome:review:{reviewId}`）。 */
export function reviewOutcomeRequestId(reviewId: string): string {
  return `outcome:review:${reviewId}`;
}

export function reviewFlowbackExists(database: DatabaseSync, workspaceId: string, reviewId: string): boolean {
  const row = database.prepare(
    `SELECT 1 FROM knowledge_change_sets
     WHERE workspace_id = ? AND request_id = ? AND trigger_source = 'review'`
  ).get(workspaceId, reviewOutcomeRequestId(reviewId));
  return row !== undefined;
}

export function unreturnedReviewPlan(
  ctx: DetectorContext,
  reviewId: string,
  status: string
): HealthLintIssuePlan | null {
  if (ctx.scope !== 'global') return null; // 业务对象（Review）只在 global 层 lint
  if (status !== 'final') return null;
  if (reviewFlowbackExists(ctx.database, ctx.workspaceId, reviewId)) return null;
  return Object.freeze({
    issueType: 'unreturned_review',
    affectedObjectType: 'review',
    affectedObjectId: reviewId,
    severity: 'medium',
    anchor: `review:${reviewId}`,
    detail: 'final Review 尚未按发布时 Usage 回流。',
    suggestedAction: '等待 Review 回流；回流 ChangeSet 出现后自动解决。'
  });
}

export function unresolvedContradictionPlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('unresolved_contradiction')) return null;
  const row = ctx.database.prepare(
    `SELECT n.lifecycle AS lifecycle, v.conclusion_status AS conclusionStatus
     FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     WHERE n.id = ? AND n.scope = ?`
  ).get(noteId, ctx.scope) as Record<string, unknown> | undefined;
  if (!row || String(row.lifecycle) !== 'active' || String(row.conclusionStatus) !== 'disputed') return null;
  return Object.freeze({
    issueType: 'unresolved_contradiction',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `note:${noteId}:current-disputed`,
    detail: '当前认识版本为 disputed：可信证据仍存在实质分歧。',
    suggestedAction: '保留争议，不自动裁决；需人工或 AI 评估后再决定强化/限域/拆分。'
  });
}

export function staleWikiPagePlan(ctx: DetectorContext, pageId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('stale_wiki_page')) return null;
  const row = ctx.database.prepare(
    `SELECT compile_status AS compileStatus, lifecycle FROM knowledge_wiki_pages WHERE id = ? AND scope = ?`
  ).get(pageId, ctx.scope) as Record<string, unknown> | undefined;
  if (!row || String(row.lifecycle) !== 'active' || String(row.compileStatus) !== 'stale') return null;
  return Object.freeze({
    issueType: 'stale_wiki_page',
    affectedObjectType: 'wiki_page',
    affectedObjectId: pageId,
    severity: 'low',
    anchor: `page:${pageId}:stale`,
    detail: 'Wiki 页面 compile_status=stale 但仍为当前页面。',
    suggestedAction: '有新资料待整理；整理后自动解决。'
  });
}

// ============================================================
// WMB-5237 知识完整性检测器（确定性；全部基于正式 SQLite 对象/版本/证据关系）
// ============================================================
// 七类：orphan（orphan_knowledge）、missing-page（missing_wiki_page）、duplicate
// （duplicate_knowledge / duplicate_entity）、unsupported（unsupported_claim）、
// stale-claim（stale_claim）、cross-reference（broken_reference@wiki_page）、
// data-gap（data_gap）。每类条件函数同时充当「problem 判定」，供计划与自动解决复用：
// 条件消除（对象被连接/修复/归档/重新编译）→ 确定性 Issue 自动 resolved；
// disputed/contradicted 等真实争议恒保持 open，不自动裁决。

/** 孤立条件：活动 Note（非 question）无任何证据链接、无任何活动正式关系、未被活动 Wiki 页面采纳。 */
export function orphanNoteCondition(ctx: DetectorContext, noteId: string): boolean {
  const database = ctx.database;
  const row = database.prepare(
    `SELECT n.id FROM knowledge_notes n
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active' AND n.kind != 'question'
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_evidence_links e
         JOIN knowledge_note_versions v ON v.id = e.knowledge_note_version_id
         WHERE v.note_id = n.id)
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_formal_relations r
         WHERE r.scope = n.scope AND r.ended_change_set_id IS NULL
           AND (r.from_object_id = n.id OR r.to_object_id = n.id))`
  ).get(noteId, ctx.scope);
  if (!row) return false;
  // 采纳按不可变版本 id 判定（adopted_note_version_ids_json 为 JSON 数组字符串；id 无引号安全）
  const versions = database.prepare('SELECT id FROM knowledge_note_versions WHERE note_id = ?').all(noteId) as Array<{ id: string }>;
  for (const version of versions) {
    const adopted = database.prepare(
      `SELECT 1 FROM knowledge_wiki_page_versions w
       JOIN knowledge_wiki_pages p ON p.id = w.page_id
       WHERE p.scope = ? AND p.lifecycle = 'active' AND w.adopted_note_version_ids_json LIKE ? LIMIT 1`
    ).get(ctx.scope, `%"${version.id}"%`);
    if (adopted) return false;
  }
  return true;
}

export function orphanKnowledgePlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('orphan_knowledge')) return null;
  if (!orphanNoteCondition(ctx, noteId)) return null;
  return Object.freeze({
    issueType: 'orphan_knowledge',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'low',
    anchor: `note:${noteId}:orphan`,
    detail: '活动知识 Note 完全孤立：无证据链接、无正式关系、未被任何 Wiki 页面采纳。',
    suggestedAction: '人工复核：补充证据/关系或并入当前认识；确认无意义可归档。'
  });
}

/** unsupported 条件：当前认识版本宣称 supported/contradicted，但没有任何有效 EvidenceLink。 */
export function noteUnsupportedCondition(ctx: DetectorContext, noteId: string): boolean {
  const row = ctx.database.prepare(
    `SELECT 1 FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active'
       AND v.conclusion_status IN ('supported','contradicted')
       AND NOT EXISTS (SELECT 1 FROM knowledge_evidence_links e WHERE e.knowledge_note_version_id = v.id)`
  ).get(noteId, ctx.scope);
  return row !== undefined;
}

export function unsupportedClaimPlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('unsupported_claim')) return null;
  if (!noteUnsupportedCondition(ctx, noteId)) return null;
  return Object.freeze({
    issueType: 'unsupported_claim',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `note:${noteId}:unsupported`,
    detail: '当前认识版本结论为 supported/contradicted，但没有任何有效 EvidenceLink 支撑。',
    suggestedAction: '人工复核：补充证据链接，或把结论降级为 unverified/inference。'
  });
}

/** stale 条件：当前认识版本带明确 valid_until 且已过时（确定性阈值 = 既有时间字段本身）。 */
export function noteStaleCondition(ctx: DetectorContext, noteId: string, nowIso: string): boolean {
  const row = ctx.database.prepare(
    `SELECT 1 FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active'
       AND v.valid_until IS NOT NULL AND v.valid_until < ?`
  ).get(noteId, ctx.scope, nowIso);
  return row !== undefined;
}

export function staleClaimPlan(ctx: DetectorContext, noteId: string, nowIso: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('stale_claim')) return null;
  if (!noteStaleCondition(ctx, noteId, nowIso)) return null;
  return Object.freeze({
    issueType: 'stale_claim',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `note:${noteId}:stale-claim`,
    detail: '当前认识版本已过明确有效期（valid_until 已到期）。',
    suggestedAction: '人工复核：更新该 Claim 的有效期/内容，或将其归档。'
  });
}

/** 重复知识条件：同 scope 存在另一活动 Note，当前陈述逐字相同（同 kind）。 */
export function duplicateKnowledgePartner(ctx: DetectorContext, noteId: string): string | null {
  const row = ctx.database.prepare(
    `SELECT MIN(n2.id) AS partnerId FROM knowledge_notes n
     JOIN knowledge_note_versions v ON v.id = n.current_version_id
     JOIN knowledge_notes n2 ON n2.scope = n.scope AND n2.lifecycle = 'active' AND n2.id != n.id
     JOIN knowledge_note_versions v2 ON v2.id = n2.current_version_id
     WHERE n.id = ? AND n.scope = ? AND n.lifecycle = 'active'
       AND n2.kind = n.kind AND trim(lower(v2.statement)) = trim(lower(v.statement))`
  ).get(noteId, ctx.scope) as { partnerId: string | null } | undefined;
  return row?.partnerId ?? null;
}

export function duplicateKnowledgePlan(ctx: DetectorContext, noteId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('duplicate_knowledge')) return null;
  const partnerId = duplicateKnowledgePartner(ctx, noteId);
  if (!partnerId) return null;
  const pairKey = [noteId, partnerId].sort().join(':');
  return Object.freeze({
    issueType: 'duplicate_knowledge',
    affectedObjectType: 'knowledge_note',
    affectedObjectId: noteId,
    severity: 'medium',
    anchor: `duplicate-note:${pairKey}`,
    detail: `活动 Note 与 ${partnerId} 的当前认识版本陈述逐字相同（同 kind），疑似重复知识。`,
    suggestedAction: '人工复核：合并/限域，或确认并存理由（不自动裁决）。'
  });
}

/** 重复实体条件：同 scope 存在另一活动 Entity，强外部身份（external_identity_json）完全相同。 */
export function duplicateEntityPartner(ctx: DetectorContext, entityId: string): string | null {
  const row = ctx.database.prepare(
    `SELECT MIN(e2.id) AS partnerId FROM knowledge_entities e
     JOIN knowledge_entities e2 ON e2.scope = e.scope AND e2.lifecycle = 'active' AND e2.id != e.id
     WHERE e.id = ? AND e.scope = ? AND e.lifecycle = 'active' AND e.external_identity_json != '{}'
       AND e2.external_identity_json = e.external_identity_json`
  ).get(entityId, ctx.scope) as { partnerId: string | null } | undefined;
  return row?.partnerId ?? null;
}

export function duplicateEntityPlan(ctx: DetectorContext, entityId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('duplicate_entity')) return null;
  const partnerId = duplicateEntityPartner(ctx, entityId);
  if (!partnerId) return null;
  const pairKey = [entityId, partnerId].sort().join(':');
  return Object.freeze({
    issueType: 'duplicate_entity',
    affectedObjectType: 'knowledge_entity',
    affectedObjectId: entityId,
    severity: 'high',
    anchor: `duplicate-entity:${pairKey}`,
    detail: `活动 Entity 与 ${partnerId} 具有完全相同的强外部身份（external_identity_json），疑似同一现实身份。`,
    suggestedAction: '人工复核：合并实体或确认为不同语境身份（强身份重复为确定性信号，但仍不自动裁决）。'
  });
}

/** 实体/主题被当前知识引用：被活动 Note 版本采纳（JSON id 数组）或作为活动正式关系目标。 */
export function entityReferencedInScope(ctx: DetectorContext, entityId: string): boolean {
  const database = ctx.database;
  const adopted = database.prepare(
    `SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.scope = ? AND v.adopted_entity_ids_json LIKE ? LIMIT 1`
  ).get(ctx.scope, `%"${entityId}"%`);
  if (adopted) return true;
  const related = database.prepare(
    `SELECT 1 FROM knowledge_formal_relations r
     WHERE r.scope = ? AND r.ended_change_set_id IS NULL
       AND r.to_object_type = 'knowledge_entity' AND r.to_object_id = ? LIMIT 1`
  ).get(ctx.scope, entityId);
  return related !== undefined;
}

export function topicReferencedInScope(ctx: DetectorContext, topicId: string): boolean {
  const database = ctx.database;
  const adopted = database.prepare(
    `SELECT 1 FROM knowledge_note_versions v JOIN knowledge_notes n ON n.id = v.note_id
     WHERE n.scope = ? AND v.adopted_topic_ids_json LIKE ? LIMIT 1`
  ).get(ctx.scope, `%"${topicId}"%`);
  if (adopted) return true;
  const related = database.prepare(
    `SELECT 1 FROM knowledge_formal_relations r
     WHERE r.scope = ? AND r.ended_change_set_id IS NULL
       AND r.to_object_type = 'topic' AND r.to_object_id = ? LIMIT 1`
  ).get(ctx.scope, topicId);
  return related !== undefined;
}

/** missing-page 条件：活动实体/主题被当前知识引用，但同 scope 没有活动 Wiki 页面。 */
export function entityMissingPageCondition(ctx: DetectorContext, entityId: string): boolean {
  const database = ctx.database;
  const active = database.prepare(
    'SELECT 1 FROM knowledge_entities WHERE id = ? AND scope = ? AND lifecycle = ? LIMIT 1'
  ).get(entityId, ctx.scope, 'active');
  if (!active) return false;
  const page = database.prepare(
    `SELECT 1 FROM knowledge_wiki_pages
     WHERE scope = ? AND subject_type = 'entity' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
  ).get(ctx.scope, entityId);
  if (page) return false;
  return entityReferencedInScope(ctx, entityId);
}

export function topicMissingPageCondition(ctx: DetectorContext, topicId: string): boolean {
  const database = ctx.database;
  const topic = database.prepare('SELECT 1 FROM topics WHERE id = ?').get(topicId);
  if (!topic) return false;
  const page = database.prepare(
    `SELECT 1 FROM knowledge_wiki_pages
     WHERE scope = ? AND subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' LIMIT 1`
  ).get(ctx.scope, topicId);
  if (page) return false;
  return topicReferencedInScope(ctx, topicId);
}

export function missingEntityPagePlan(ctx: DetectorContext, entityId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('missing_wiki_page')) return null;
  if (!entityMissingPageCondition(ctx, entityId)) return null;
  return Object.freeze({
    issueType: 'missing_wiki_page',
    affectedObjectType: 'knowledge_entity',
    affectedObjectId: entityId,
    severity: 'medium',
    anchor: `entity:${entityId}:missing-page`,
    detail: '活动 Entity 被当前知识引用（Note 采纳/正式关系），但没有活动 Wiki 页面。',
    suggestedAction: '人工复核：为该实体整理出当前认识，或移除其引用。'
  });
}

export function missingTopicPagePlan(ctx: DetectorContext, topicId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('missing_wiki_page')) return null;
  if (!topicMissingPageCondition(ctx, topicId)) return null;
  return Object.freeze({
    issueType: 'missing_wiki_page',
    affectedObjectType: 'topic',
    affectedObjectId: topicId,
    severity: 'medium',
    anchor: `topic:${topicId}:missing-page`,
    detail: 'Topic 被当前知识引用（Note 采纳/正式关系），但没有活动 Wiki 页面。',
    suggestedAction: '人工复核：为该主题整理出当前认识，或确认已并入其他页面。'
  });
}

/** 解析 business_object_refs 形式化引用；未知形态放行（不做自由文本猜测）。 */
export function parseWikiRef(ref: unknown): { type: string; id: string } | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length < 2) return null;
  const type = parts[0]!.trim();
  const id = parts[1]!.trim();
  if (!type || !id) return null;
  return { type, id };
}

/** 当前 Wiki 页面版本中不可解析的正式引用（结构字段：adopted_note_version_ids / business_object_refs）。 */
export function pageCurrentBrokenRefs(ctx: DetectorContext, pageId: string): Array<{ kind: string; type: string; id: string }> {
  const database = ctx.database;
  const page = database.prepare(
    'SELECT current_version_id AS versionId, lifecycle, scope FROM knowledge_wiki_pages WHERE id = ?'
  ).get(pageId) as Record<string, unknown> | undefined;
  if (!page || String(page.scope) !== ctx.scope || String(page.lifecycle) !== 'active') return [];
  const versionId = String(page.versionId ?? '');
  if (!versionId) return [];
  const version = database.prepare(
    `SELECT adopted_note_version_ids_json AS adopted, business_object_refs_json AS refs
     FROM knowledge_wiki_page_versions WHERE id = ?`
  ).get(versionId) as Record<string, unknown> | undefined;
  if (!version) return [];
  const broken: Array<{ kind: string; type: string; id: string }> = [];
  let adopted: unknown[] = [];
  let refs: unknown[] = [];
  try {
    adopted = JSON.parse(String(version.adopted ?? '[]')) as unknown[];
  } catch {
    adopted = [];
  }
  try {
    refs = JSON.parse(String(version.refs ?? '[]')) as unknown[];
  } catch {
    refs = [];
  }
  for (const adoptedId of adopted) {
    if (typeof adoptedId !== 'string' || !adoptedId) continue;
    if (!objectExists(database, WIKI_REF_TABLES.note_version!, adoptedId)) {
      broken.push({ kind: 'adopted_note_version', type: 'note_version', id: adoptedId });
    }
  }
  for (const ref of refs) {
    const parsed = parseWikiRef(ref);
    if (!parsed) continue;
    const table = WIKI_REF_TABLES[parsed.type];
    if (!table) continue; // 未知类型不做猜测
    if (!objectExists(database, table, parsed.id)) {
      broken.push({ kind: 'business_object_ref', type: parsed.type, id: parsed.id });
    }
  }
  return broken;
}

export function crossReferencePlan(ctx: DetectorContext, pageId: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('cross_reference')) return null;
  const broken = pageCurrentBrokenRefs(ctx, pageId);
  if (!broken.length) return null;
  return Object.freeze({
    issueType: 'broken_reference',
    affectedObjectType: 'wiki_page',
    affectedObjectId: pageId,
    severity: 'medium',
    anchor: `page-ref:${pageId}`,
    detail: `Wiki 页面当前版本包含不可解析的正式引用：${broken.map((b) => `${b.kind}:${b.type}:${b.id}`).join('、')}。`,
    suggestedAction: '人工复核：重新整理当前认识（清除失效引用）或恢复被引用对象。'
  });
}

/** data-gap 条件：captured FreeNote 超过业务阈值天数仍未处理（原始观察未进入知识管线）。 */
export function dataGapCondition(ctx: DetectorContext, freeNoteId: string, cutoffIso: string): boolean {
  const row = ctx.database.prepare(
    `SELECT 1 FROM knowledge_free_notes
     WHERE id = ? AND scope = ? AND processing_state = 'captured' AND created_at < ?`
  ).get(freeNoteId, ctx.scope, cutoffIso);
  return row !== undefined;
}

export function dataGapPlan(ctx: DetectorContext, freeNoteId: string, cutoffIso: string): HealthLintIssuePlan | null {
  if (!ctx.detectors.includes('data_gap')) return null;
  if (!dataGapCondition(ctx, freeNoteId, cutoffIso)) return null;
  return Object.freeze({
    issueType: 'data_gap',
    affectedObjectType: 'knowledge_free_note',
    affectedObjectId: freeNoteId,
    severity: 'low',
    anchor: `free-note:${freeNoteId}:unprocessed`,
    detail: `captured FreeNote 超过 ${DATA_GAP_FREE_NOTE_MAX_AGE_DAYS} 天仍未处理，原始观察未进入知识管线。`,
    suggestedAction: '人工复核：处理该原始记录（晋升/忽略/归档），或确认延迟原因。'
  });
}
