// WMB-5212 M3：主题与资料库后端读模型（本 worker：ImplementKnowledgeSurfaceBackend）。
// Design: docs/spark/2026-08-12-wmb-existing-knowledge-surfaces-retrofit-design.md §3–§4、§6–§10。
// 定位：LibraryTopicsView（Topic Wiki 详情）与 LibraryView（Source 详情/Inbox/Health）的
// 后端投影。全部复用 v56/v57 既有表 + 既有 dossier（getKnowledgeTopicDossier），不新建身份/表：
// - Topic Wiki 详情 = 业务 topics 行 + knowledge_wiki_pages(subject_type='topic') 当前版本
//   （含编译器正文解析、compile_status stale/failed 读回）+ 版本时间线 + 回执(affectedTopics)
//   + 采纳 Note 版本证据 + 创作 Usage 影响 + Health + 既有八类 dossier 计数；
// - Source 详情 = source_items 行 + 关联 Topic + Evidence(source→固定 Note 版本) + 回执
//   (impact.sourceId) + Health(source 作用域) + Note 版本批注；
// - 深链 payload：topic→wiki page / source→library / 知识对象，同一正式对象 ID 空间。
// 输出契约类型真源在 src/shared/knowledge-topic-library.ts；主进程 store 记录字段更宽
// （scope: string 等），本模块在组装边界收窄为共享契约（数据同构，仅类型收窄）。
import { DatabaseSync } from 'node:sqlite';
import { getKnowledgeTopicDossier } from './knowledge.ts';
import {
  getWikiPage, listHealthIssues, listKnowledgeEvidenceLinks, listUpdateReceipts, listWikiPageVersions, listWikiPages
} from './knowledge-flywheel.ts';
// WMB-5233：诚实三态判定（与 Canvas 投影共用同一判定，保证同一对象身份一致）。
import { classifyWikiCompileState } from './knowledge-compile-state.ts';
import type {
  KnowledgeEvidenceLinkRecord, KnowledgeHealthIssueRecord, KnowledgeUsageRecordRecord,
  KnowledgeWikiPageRecord, KnowledgeWikiPageVersionRecord
} from '../shared/knowledge-flywheel.ts';
import type {
  KnowledgeDeepLinkInput, KnowledgeDeepLinkPayload, SourceKnowledgeDetail,
  SourceKnowledgeDetailInput, TopicEvidenceEntry, TopicWikiBody, TopicWikiDetail, TopicWikiDetailInput,
  TopicWikiKeyConclusion, TopicWikiRecentChange, TopicWikiRisks
} from '../shared/knowledge-topic-library.ts';

const MAX_LIMIT = 100;

function bound(input: { limit?: number; offset?: number }, fallbackLimit = 20): { limit: number; offset: number } {
  const limit = Math.min(Math.max(input.limit ?? fallbackLimit, 1), MAX_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);
  return { limit, offset };
}

function emptyPage<T>(limit: number) {
  return Object.freeze({ items: [] as readonly T[], total: 0, limit, offset: 0, hasMore: false });
}

function parseTopicWikiBody(value: unknown): TopicWikiBody | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (body.kind !== 'topic-wiki') return null;
  return Object.freeze({
    kind: 'topic-wiki',
    title: String(body.title ?? ''),
    summary: String(body.summary ?? ''),
    asOf: String(body.asOf ?? ''),
    scope: String(body.scope ?? ''),
    topicId: String(body.topicId ?? ''),
    compiledSourceIds: Array.isArray(body.compiledSourceIds) ? body.compiledSourceIds.map(String) : [],
    sourceRevision: Number(body.sourceRevision ?? 0),
    keyConclusions: (Array.isArray(body.keyConclusions) ? body.keyConclusions : []) as unknown as readonly TopicWikiKeyConclusion[],
    retainedDisputes: (Array.isArray(body.retainedDisputes) ? body.retainedDisputes : []) as unknown as readonly TopicWikiKeyConclusion[],
    pendingQuestions: (Array.isArray(body.pendingQuestions) ? body.pendingQuestions : []).map(String),
    recentChanges: (Array.isArray(body.recentChanges) ? body.recentChanges : []) as unknown as readonly TopicWikiRecentChange[],
    versionCount: Number(body.versionCount ?? 0)
  });
}

function computeRisks(body: TopicWikiBody | null, compileStatus: KnowledgeWikiPageRecord['compileStatus'] | null): TopicWikiRisks {
  const conclusions = body?.keyConclusions ?? [];
  let disputed = 0, contradicted = 0, inference = 0;
  for (const entry of conclusions) {
    if (entry.conclusionStatus === 'disputed') disputed += 1;
    else if (entry.conclusionStatus === 'contradicted') contradicted += 1;
    else if (entry.conclusionStatus === 'inference') inference += 1;
  }
  return Object.freeze({ disputed, contradicted, inference, stale: compileStatus === 'stale', failed: compileStatus === 'failed' });
}

// ===== Topic 业务身份（listKnowledgeTopics 同源口径；仅单 Topic 精确解析） =====
function topicIdentity(database: DatabaseSync, topicId: string) {
  const rows = database.prepare(`SELECT t.id, t.title, t.canonical_key AS canonicalKey, t.kind, t.summary, t.status,
    t.first_seen_at AS firstSeenAt, t.last_seen_at AS lastSeenAt, t.revision,
    count(DISTINCT l.source_id) AS sourceCount,
    count(DISTINCT pi.id) AS opportunityCount,
    (
      SELECT count(DISTINCT cp.id) FROM content_projects cp
      WHERE cp.topic_id = t.id OR EXISTS(
        SELECT 1 FROM content_project_sources cps
        JOIN topic_source_links linked ON linked.source_id = cps.source_id
        WHERE cps.project_id = cp.id AND linked.topic_id = t.id
      )
    ) AS contentCount,
    (
      SELECT count(DISTINCT p.id) FROM content_projects cp
      JOIN content_versions cv ON cv.project_id = cp.id
      JOIN platform_versions pv ON pv.content_version_id = cv.id
      JOIN publications p ON p.platform_version_id = pv.id
      WHERE p.status = 'published' AND (
        cp.topic_id = t.id OR EXISTS(
          SELECT 1 FROM content_project_sources cps
          JOIN topic_source_links linked ON linked.source_id = cps.source_id
          WHERE cps.project_id = cp.id AND linked.topic_id = t.id
        )
      )
    ) AS publicationCount
    FROM topics t
    LEFT JOIN topic_source_links l ON l.topic_id = t.id
    LEFT JOIN plan_items pi ON pi.topic_id = t.id
    WHERE t.id = ? AND t.status != 'archived'
    GROUP BY t.id`).all(topicId) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return Object.freeze({
    id: String(row.id), title: String(row.title), canonicalKey: (row.canonicalKey as string | null) ?? null,
    kind: (row.kind as string | null) ?? null, summary: (row.summary as string | null) ?? null, status: String(row.status),
    firstSeenAt: String(row.firstSeenAt), lastSeenAt: String(row.lastSeenAt), revision: Number(row.revision),
    sourceCount: Number(row.sourceCount), opportunityCount: Number(row.opportunityCount),
    contentCount: Number(row.contentCount), publicationCount: Number(row.publicationCount)
  });
}

// ===== 证据收集：固定 Note 版本集合上的证据链（有界；输出收窄为共享契约） =====
const EVIDENCE_SELECT = `SELECT id, knowledge_note_version_id AS knowledgeNoteVersionId,
  evidence_object_type AS evidenceObjectType, evidence_object_id AS evidenceObjectId, relation, source_nature AS sourceNature,
  excerpt, locator, observed_at AS observedAt, creator_nature AS creatorNature, change_set_id AS changeSetId, created_at AS createdAt
  FROM knowledge_evidence_links`;

function collectEvidenceForNoteVersions(database: DatabaseSync, noteVersionIds: readonly string[], limit: number) {
  const ids = [...new Set(noteVersionIds)].filter(Boolean);
  if (!ids.length) return emptyPage<KnowledgeEvidenceLinkRecord>(limit);
  const placeholders = ids.map(() => '?').join(',');
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_evidence_links
    WHERE knowledge_note_version_id IN (${placeholders})`).get(...ids) as { count: number }).count);
  const rows = database.prepare(`${EVIDENCE_SELECT} WHERE knowledge_note_version_id IN (${placeholders})
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(...ids, limit) as Array<Record<string, unknown>>;
  const items = rows.map((row) => Object.freeze({
    id: String(row.id), knowledgeNoteVersionId: String(row.knowledgeNoteVersionId),
    evidenceObjectType: row.evidenceObjectType as KnowledgeEvidenceLinkRecord['evidenceObjectType'],
    evidenceObjectId: String(row.evidenceObjectId),
    relation: row.relation as KnowledgeEvidenceLinkRecord['relation'],
    sourceNature: row.sourceNature as KnowledgeEvidenceLinkRecord['sourceNature'],
    excerpt: (row.excerpt as string | null) ?? null, locator: (row.locator as string | null) ?? null,
    observedAt: (row.observedAt as string | null) ?? null, creatorNature: row.creatorNature as KnowledgeEvidenceLinkRecord['creatorNature'],
    changeSetId: String(row.changeSetId), createdAt: String(row.createdAt)
  }));
  return Object.freeze({ items, total, limit, offset: 0, hasMore: total > limit });
}

/** 证据条目 + 被支持 Note 版本一句话（Topic/Source 详情共用）。 */
function enrichEvidence(database: DatabaseSync, page: { items: readonly KnowledgeEvidenceLinkRecord[]; total: number; limit: number; offset: number; hasMore: boolean }) {
  const versionIds = [...new Set(page.items.map((item) => item.knowledgeNoteVersionId))].filter(Boolean);
  const statements = new Map<string, { statement: string; conclusionStatus: string }>();
  if (versionIds.length) {
    const placeholders = versionIds.map(() => '?').join(',');
    const rows = database.prepare(`SELECT id, statement, conclusion_status AS conclusionStatus
      FROM knowledge_note_versions WHERE id IN (${placeholders})`).all(...versionIds) as Array<Record<string, unknown>>;
    for (const row of rows) statements.set(String(row.id), {
      statement: String(row.statement ?? ''), conclusionStatus: String(row.conclusionStatus ?? 'unverified')
    });
  }
  const items = page.items.map((item) => {
    const meta = statements.get(item.knowledgeNoteVersionId);
    return Object.freeze({ ...item, noteStatement: meta?.statement ?? '', noteConclusionStatus: (meta?.conclusionStatus ?? 'unverified') as TopicEvidenceEntry['noteConclusionStatus'] });
  });
  return Object.freeze({ items, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore });
}

// ===== 创作影响：Usage Record 固定引用当前 Wiki 版本或采纳 Note 版本（有界） =====
const USAGE_RECORD_SELECT = `SELECT id, scope, workspace_id AS workspaceId, package_id AS packageId,
  output_object_type AS outputObjectType, output_object_id AS outputObjectId,
  note_version_id AS noteVersionId, wiki_page_version_id AS wikiPageVersionId,
  usage_kind AS usageKind, used, locator, reason, actor, evidence_id AS evidenceId,
  created_by AS createdBy, created_at AS createdAt FROM knowledge_usage_records`;

function collectCreationImpact(database: DatabaseSync, wikiVersionId: string, adoptedNoteVersionIds: readonly string[], limit: number) {
  const ids = [...new Set(adoptedNoteVersionIds)].filter(Boolean);
  const clause = ids.length
    ? 'WHERE wiki_page_version_id = ? OR note_version_id IN (' + ids.map(() => '?').join(',') + ')'
    : 'WHERE wiki_page_version_id = ?';
  const args: Array<string> = [wikiVersionId, ...ids];
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_usage_records ${clause}`).get(...args) as { count: number }).count);
  const rows = database.prepare(`${USAGE_RECORD_SELECT} ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit) as Array<Record<string, unknown>>;
  const items = rows.map((row) => {
    const noteVersionId = (row.noteVersionId as string | null) ?? null;
    const wikiPageVersionId = (row.wikiPageVersionId as string | null) ?? null;
    return Object.freeze({
      id: String(row.id), scope: String(row.scope) as KnowledgeUsageRecordRecord['scope'], workspaceId: String(row.workspaceId), packageId: String(row.packageId),
      outputObjectType: row.outputObjectType as KnowledgeUsageRecordRecord['outputObjectType'],
      outputObjectId: String(row.outputObjectId),
      // 共享契约派生字段：note_version_id XOR wiki_page_version_id → 固定知识版本。
      knowledgeVersionId: String(noteVersionId ?? wikiPageVersionId),
      knowledgeVersionKind: (noteVersionId ? 'note' : 'wiki_page') as KnowledgeUsageRecordRecord['knowledgeVersionKind'],
      usageKind: row.usageKind as KnowledgeUsageRecordRecord['usageKind'], used: Number(row.used) === 1,
      locator: (row.locator as string | null) ?? null, reason: String(row.reason ?? ''), actor: String(row.actor ?? ''),
      evidenceId: (row.evidenceId as string | null) ?? null, createdBy: row.createdBy as KnowledgeUsageRecordRecord['createdBy'],
      createdAt: String(row.createdAt)
    });
  });
  return Object.freeze({ items, total, limit, offset: 0, hasMore: total > limit });
}

// ===== 健康：受影响对象命中 Topic 或 Topic Wiki 页面（有界） =====
const HEALTH_SELECT = `SELECT id, scope, issue_type AS issueType, affected_object_type AS affectedObjectType,
  affected_object_id AS affectedObjectId, severity, evidence_json AS evidenceJson, suggested_action AS suggestedAction, status,
  resolution_note AS resolutionNote, resolved_change_set_id AS resolvedChangeSetId, detected_at AS detectedAt,
  updated_at AS updatedAt, resolved_at AS resolvedAt, revision FROM knowledge_health_issues`;

function collectHealthForObjects(database: DatabaseSync, objectIds: readonly string[], limit: number) {
  const ids = [...new Set(objectIds)].filter(Boolean);
  if (!ids.length) return emptyPage<KnowledgeHealthIssueRecord>(limit);
  const placeholders = ids.map(() => '?').join(',');
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_health_issues
    WHERE affected_object_id IN (${placeholders})`).get(...ids) as { count: number }).count);
  const rows = database.prepare(`${HEALTH_SELECT} WHERE affected_object_id IN (${placeholders})
    ORDER BY detected_at DESC, id DESC LIMIT ?`).all(...ids, limit) as Array<Record<string, unknown>>;
  const items = rows.map((row) => Object.freeze({
    id: String(row.id), scope: String(row.scope) as KnowledgeHealthIssueRecord['scope'], issueType: row.issueType as KnowledgeHealthIssueRecord['issueType'],
    affectedObjectType: (row.affectedObjectType as string | null) ?? null, affectedObjectId: (row.affectedObjectId as string | null) ?? null,
    severity: row.severity as KnowledgeHealthIssueRecord['severity'],
    evidence: JSON.parse(String(row.evidenceJson)) as Readonly<Record<string, unknown>>,
    suggestedAction: String(row.suggestedAction ?? ''), status: row.status as KnowledgeHealthIssueRecord['status'],
    resolutionNote: (row.resolutionNote as string | null) ?? null, resolvedChangeSetId: (row.resolvedChangeSetId as string | null) ?? null,
    detectedAt: String(row.detectedAt), updatedAt: String(row.updatedAt), resolvedAt: (row.resolvedAt as string | null) ?? null,
    revision: Number(row.revision)
  }));
  return Object.freeze({ items, total, limit, offset: 0, hasMore: total > limit });
}

export function getTopicWikiDetail(database: DatabaseSync, rawInput: TopicWikiDetailInput): TopicWikiDetail {
  const topicId = String(rawInput.topicId ?? '');
  const versionsLimit = bound({ limit: rawInput.versionsLimit }, 20).limit;
  const receiptsLimit = bound({ limit: rawInput.receiptsLimit }, 20).limit;
  const evidenceLimit = bound({ limit: rawInput.evidenceLimit }, 30).limit;
  const healthLimit = bound({ limit: rawInput.healthLimit }, 20).limit;
  const usageLimit = bound({ limit: rawInput.usageLimit }, 20).limit;
  const questionsLimit = Math.min(Math.max(rawInput.questionsLimit ?? 20, 0), MAX_LIMIT);

  const topic = topicIdentity(database, topicId);
  let page: KnowledgeWikiPageRecord | null = null;
  let current: KnowledgeWikiPageVersionRecord | null = null;
  const pageRows = listWikiPages(database, { subjectType: 'topic', subjectId: topicId, pageType: 'topic', lifecycle: 'active', limit: 1 });
  if (pageRows.items.length > 0) {
    const detail = getWikiPage(database, pageRows.items[0].id);
    if (detail) {
      page = detail.page as unknown as KnowledgeWikiPageRecord;
      current = detail.version as unknown as KnowledgeWikiPageVersionRecord;
    }
  }
  const body = parseTopicWikiBody(current?.body);
  const versions = (page
    ? listWikiPageVersions(database, page.id, { limit: versionsLimit })
    : emptyPage<KnowledgeWikiPageVersionRecord>(versionsLimit)) as unknown as TopicWikiDetail['versions'];
  const receipts = listUpdateReceipts(database, { topicId, limit: receiptsLimit }) as unknown as TopicWikiDetail['receipts'];
  const evidence = current
    ? enrichEvidence(database, collectEvidenceForNoteVersions(database, current.adoptedNoteVersionIds, evidenceLimit))
    : emptyPage<TopicEvidenceEntry>(evidenceLimit);
  const questions = body ? body.pendingQuestions.slice(0, questionsLimit) : [];
  const creationImpact = current
    ? collectCreationImpact(database, current.id, current.adoptedNoteVersionIds, usageLimit)
    : emptyPage<KnowledgeUsageRecordRecord>(usageLimit);
  const healthIssues = collectHealthForObjects(database, page ? [topicId, page.id] : [topicId], healthLimit);
  let dossierCounts: TopicWikiDetail['dossierCounts'] = null;
  if (topic) {
    try {
      const dossier = getKnowledgeTopicDossier(database, { topicId, limit: 1, offset: 0 });
      dossierCounts = Object.freeze({ ...dossier.counts });
    } catch {
      dossierCounts = null;
    }
  }
  const risks = computeRisks(body, page?.compileStatus ?? null);
  // WMB-5233：诚实三态（uncompiled / legacy_shell / compiled），空壳不随 compile_status 显示已编译。
  const compileState = classifyWikiCompileState({ page, current, body });
  return Object.freeze({
    topicId,
    topic,
    wiki: page || current || body ? { page, current, body, compileStatus: page?.compileStatus ?? null, compileNote: page?.compileNote ?? null, compileState } : null,
    versions, receipts, evidence, questions, creationImpact, healthIssues, dossierCounts, risks
  });
}

// ===== Source 详情 =====
export function getSourceKnowledgeDetail(database: DatabaseSync, rawInput: SourceKnowledgeDetailInput): SourceKnowledgeDetail {
  const sourceId = String(rawInput.sourceId ?? '');
  const evidenceLimit = bound({ limit: rawInput.evidenceLimit }, 30).limit;
  const receiptLimit = bound({ limit: rawInput.receiptLimit }, 20).limit;
  const healthLimit = bound({ limit: rawInput.healthLimit }, 20).limit;
  const annotationLimit = bound({ limit: rawInput.annotationLimit }, 20).limit;

  const sourceRow = database.prepare(`SELECT id, title, original_url AS originalUrl, summary, priority,
    verification_status AS verificationStatus, management_status AS managementStatus, revision,
    collected_at AS collectedAt, updated_at AS updatedAt FROM source_items WHERE id = ?`)
    .get(sourceId) as Record<string, unknown> | undefined;
  const source = sourceRow ? Object.freeze({
    id: String(sourceRow.id), title: String(sourceRow.title),
    originalUrl: (sourceRow.originalUrl as string | null) ?? null, summary: (sourceRow.summary as string | null) ?? null,
    priority: (sourceRow.priority as number | null) ?? null,
    verificationStatus: String(sourceRow.verificationStatus ?? 'pending'),
    managementStatus: String(sourceRow.managementStatus ?? 'active'),
    revision: Number(sourceRow.revision),
    collectedAt: (sourceRow.collectedAt as string | null) ?? null, updatedAt: (sourceRow.updatedAt as string | null) ?? null
  }) : null;

  const topics = (database.prepare(`SELECT t.id, t.title, t.status FROM topic_source_links l
    JOIN topics t ON t.id = l.topic_id WHERE l.source_id = ? AND t.status != 'archived'
    ORDER BY t.last_seen_at DESC, t.id DESC`).all(sourceId) as Array<Record<string, unknown>>)
    .map((row) => Object.freeze({ id: String(row.id), title: String(row.title), status: String(row.status) }));

  const rawEvidence = listKnowledgeEvidenceLinks(database, { evidenceObjectType: 'source', evidenceObjectId: sourceId, limit: evidenceLimit }) as unknown as {
    items: readonly KnowledgeEvidenceLinkRecord[]; total: number; limit: number; offset: number; hasMore: boolean;
  };
  const evidence = enrichEvidence(database, rawEvidence) as unknown as SourceKnowledgeDetail['evidence'];
  const receipts = listUpdateReceipts(database, { sourceId, limit: receiptLimit }) as unknown as SourceKnowledgeDetail['receipts'];
  const healthIssues = listHealthIssues(database, { affectedObjectType: 'source', affectedObjectId: sourceId, limit: healthLimit }) as unknown as SourceKnowledgeDetail['healthIssues'];

  // 批注：本 Source 证据链涉及的固定 Note 版本上的用户批注（有界）。
  const noteVersionIds = [...new Set(rawEvidence.items.map((item) => item.knowledgeNoteVersionId))].filter(Boolean);
  let annotations: SourceKnowledgeDetail['annotations'] = emptyPage(annotationLimit);
  if (noteVersionIds.length) {
    const placeholders = noteVersionIds.map(() => '?').join(',');
    const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_annotations
      WHERE target_type = 'knowledge_note_version' AND target_id IN (${placeholders})`).get(...noteVersionIds) as { count: number }).count);
    const rows = database.prepare(`SELECT id, target_type AS targetType, target_id AS targetId, intent, body,
      processing_state AS processingState, created_by AS createdBy, created_at AS createdAt
      FROM knowledge_annotations WHERE target_type = 'knowledge_note_version' AND target_id IN (${placeholders})
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...noteVersionIds, annotationLimit) as Array<Record<string, unknown>>;
    annotations = Object.freeze({
      items: rows.map((row) => Object.freeze({
        id: String(row.id), targetType: String(row.targetType), targetId: String(row.targetId), intent: String(row.intent),
        body: String(row.body), processingState: String(row.processingState), createdBy: String(row.createdBy), createdAt: String(row.createdAt)
      })),
      total, limit: annotationLimit, offset: 0, hasMore: total > annotationLimit
    });
  }

  return Object.freeze({ sourceId, source, topics, evidence, receipts, healthIssues, annotations });
}

// ===== 深链 payload（准确 topic/source 跳转） =====
export function resolveKnowledgeDeepLink(database: DatabaseSync, input: KnowledgeDeepLinkInput): KnowledgeDeepLinkPayload {
  const objectType = String(input.objectType ?? '');
  const objectId = String(input.objectId ?? '');
  if (objectType === 'topic') {
    const topic = database.prepare(`SELECT title FROM topics WHERE id = ? AND status != 'archived'`).get(objectId) as { title: string } | undefined;
    if (!topic) {
      return Object.freeze({ objectType, objectId, title: '', route: 'topic', targetType: 'topic_wiki', targetId: objectId, hasWiki: false, formalObjectType: null, formalObjectId: null, exists: false });
    }
    let pageId: string | null = null;
    try {
      const page = database.prepare(`SELECT id FROM knowledge_wiki_pages
        WHERE subject_type = 'topic' AND subject_id = ? AND lifecycle = 'active' ORDER BY updated_at DESC LIMIT 1`)
        .get(objectId) as { id: string } | undefined;
      pageId = page?.id ?? null;
    } catch {
      pageId = null; // 精简 fixture 缺 v56 表 → 无正式知识身份
    }
    return Object.freeze({
      objectType, objectId, title: topic.title, route: 'topic', targetType: 'topic_wiki',
      targetId: pageId ?? objectId, hasWiki: Boolean(pageId),
      formalObjectType: pageId ? 'wiki_page' : null, formalObjectId: pageId, exists: true
    });
  }
  if (objectType === 'source') {
    const source = database.prepare('SELECT title FROM source_items WHERE id = ?').get(objectId) as { title: string } | undefined;
    if (!source) {
      return Object.freeze({ objectType, objectId, title: '', route: 'library', targetType: 'source', targetId: objectId, hasWiki: false, formalObjectType: null, formalObjectId: null, exists: false });
    }
    return Object.freeze({
      objectType, objectId, title: source.title, route: 'library', targetType: 'source',
      targetId: objectId, hasWiki: false, formalObjectType: null, formalObjectId: null, exists: true
    });
  }
  const objectTables: Readonly<Record<string, string>> = Object.freeze({
    wiki_page: 'knowledge_wiki_pages', knowledge_note: 'knowledge_notes',
    knowledge_entity: 'knowledge_entities', free_note: 'knowledge_free_notes'
  });
  const table = objectTables[objectType];
  if (!table) {
    return Object.freeze({ objectType, objectId, title: '', route: 'object', targetType: 'knowledge_object', targetId: objectId, hasWiki: false, formalObjectType: null, formalObjectId: null, exists: false });
  }
  let title = '';
  let exists = false;
  try {
    const titleExpr = objectType === 'knowledge_entity' ? 'canonical_name' : objectType === 'free_note' ? 'substr(body, 1, 80)' : 'title';
    const row = database.prepare(`SELECT ${titleExpr} AS title FROM ${table} WHERE id = ?`).get(objectId) as
      | { title?: string | null } | undefined;
    exists = Boolean(row);
    title = String(row?.title ?? '');
  } catch {
    exists = false;
  }
  return Object.freeze({
    objectType, objectId, title, route: 'object', targetType: 'knowledge_object',
    targetId: objectId, hasWiki: false,
    formalObjectType: objectType as KnowledgeDeepLinkPayload['formalObjectType'], formalObjectId: exists ? objectId : null,
    exists
  });
}
