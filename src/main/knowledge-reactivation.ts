/**
 * WMB-5359：别名确认后的有界旧证据重激活与 EditorialBrief 投影。
 * 只从 source_items / source_body_cache / 现有知识版本读取，不引入第二来源库或向量索引。
 */
import type { DatabaseSync } from 'node:sqlite';
import { getSourceBodyCache } from './source-body-cache.ts';
import { getSource, type SourceRecord } from './sources.ts';

export const DEFAULT_REACTIVATION_HISTORY_DAYS = 90;
export const DEFAULT_REACTIVATION_MAX_SOURCES = 20;
export const DEFAULT_REACTIVATION_MAX_BODY_CHARS = 20_000;
export const DEFAULT_REACTIVATION_MAX_RELATION_HOPS = 1;
export const DEFAULT_REACTIVATION_MAX_CLAIMS = 50;
export const DEFAULT_REACTIVATION_MAX_RECEIPTS = 10;

export type KnowledgeReactivationSearchInput = Readonly<{
  entityId: string;
  entityRevision: number;
  aliases: readonly string[];
  currentSourceId: string;
  currentCollectedAt: string;
  now?: Date;
  historyDays?: number;
  maxSources?: number;
  maxBodyChars?: number;
  maxRelationHops?: number;
}>;

export type KnowledgeReactivationSource = Readonly<{
  sourceId: string;
  revision: number;
  title: string;
  originalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  summary: string | null;
  verificationStatus: string;
  managementStatus: string;
  body: string;
  bodyKind: 'body_cache' | 'summary' | 'none';
  matchedAliases: readonly string[];
  existingTopicIds: readonly string[];
}>;

export type KnowledgeReactivationSearchResult = Readonly<{
  candidates: readonly KnowledgeReactivationSource[];
  skipped: readonly Readonly<{ sourceId: string; reasonCode: string; reason: string }>[];
}>;

export type KnowledgeReactivationJobInput = Readonly<{
  sourceId: string;
  sourceRevision: number;
  currentSourceId: string;
  currentSourceRevision: number;
  entityId: string;
  entityRevision: number;
  topicId: string;
  reason: string;
  matchedAliases: readonly string[];
  evidenceGaps: readonly Readonly<Record<string, unknown>>[];
}>;

export type ReactivatedEvidencePack = Readonly<{
  reactivationJobId?: string;
  reactivationReason: string;
  entity: Readonly<{
    id: string;
    canonicalKey: string;
    canonicalName: string;
    aliases: readonly string[];
    revision: number;
  }> | null;
  topic: Readonly<{
    id: string;
    title: string;
    revision: number;
    wikiPageVersionId: string | null;
    wikiVersionNumber: number | null;
  }> | null;
  sources: readonly Readonly<{
    id: string;
    title: string;
    author: string | null;
    originalUrl: string | null;
    publishedAt: string | null;
    collectedAt: string;
    summary: string | null;
    verificationStatus: string;
    revision: number;
  }>[];
  claims: readonly Readonly<{
    noteId: string;
    versionId: string;
    canonicalKey: string;
    statement: string;
    conclusionStatus: string;
    evidenceLevel: string;
    appliesTo: string;
    evidenceObjectId: string;
    relation: string;
    excerpt: string | null;
    locator: string | null;
  }>[];
  disputes: readonly Readonly<Record<string, unknown>>[];
  evidenceGaps: readonly Readonly<Record<string, unknown>>[];
  receipts: readonly Readonly<Record<string, unknown>>[];
}>;

type SourceRow = Readonly<{
  id: string;
  revision: number;
  title: string;
  originalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  summary: string | null;
  verificationStatus: string;
  managementStatus: string;
}>;

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !result.some((item) => normalize(item) === normalize(trimmed))) result.push(trimmed);
  }
  return result;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function sourceBody(database: DatabaseSync, row: SourceRow): { body: string; bodyKind: 'body_cache' | 'summary' | 'none' } {
  const cache = getSourceBodyCache(database, row.id);
  if (cache?.status === 'ready' && cache.extractedText.trim()) return { body: cache.extractedText, bodyKind: 'body_cache' };
  if (row.summary?.trim()) return { body: row.summary, bodyKind: 'summary' };
  return { body: '', bodyKind: 'none' };
}

function relatedTopicIds(database: DatabaseSync, sourceId: string, maxRelationHops: number): readonly string[] {
  // topic_source_links 是当前唯一正式关系；hops 目前只允许 0/1，显式保留参数避免未来无界扩散。
  if (maxRelationHops < 1) return [];
  return (database.prepare(`SELECT DISTINCT topic_id AS topicId FROM topic_source_links
    WHERE source_id=? ORDER BY topic_id LIMIT 20`).all(sourceId) as Array<{ topicId: string }>).map((row) => row.topicId);
}

function matchedAliases(text: string, aliases: readonly string[]): readonly string[] {
  const normalizedText = normalize(text);
  return uniqueNonEmpty(aliases).filter((alias) => normalizedText.includes(normalize(alias)));
}

/**
 * 在固定时间、数量、正文长度和关系跳数内寻找旧 Source。查询结果只作为待重激活候选，
 * 不在此处写 Topic 关系，也不把命中的文字升级成正式 Claim。
 */
export function findHistoricalKnowledgeSources(
  database: DatabaseSync,
  input: KnowledgeReactivationSearchInput
): KnowledgeReactivationSearchResult {
  const aliases = uniqueNonEmpty(input.aliases).slice(0, 20);
  if (!aliases.length) return Object.freeze({ candidates: Object.freeze([]), skipped: Object.freeze([]) });
  const now = input.now ?? new Date();
  const historyDays = clamp(input.historyDays, DEFAULT_REACTIVATION_HISTORY_DAYS, 1, 3650);
  const maxSources = clamp(input.maxSources, DEFAULT_REACTIVATION_MAX_SOURCES, 1, 100);
  const maxBodyChars = clamp(input.maxBodyChars, DEFAULT_REACTIVATION_MAX_BODY_CHARS, 100, 100_000);
  const maxRelationHops = clamp(input.maxRelationHops, DEFAULT_REACTIVATION_MAX_RELATION_HOPS, 0, 1);
  const since = new Date(now.getTime() - historyDays * 86_400_000).toISOString();
  const aliasFilter = aliases.map(() => `instr(lower(coalesce(s.title,'') || char(10) || coalesce(s.summary,'') || char(10) || coalesce(c.extracted_text,'')), lower(?)) > 0`).join(' OR ');
  const rows = database.prepare(`SELECT s.id, s.revision, s.title, s.original_url AS originalUrl, s.author,
      s.published_at AS publishedAt, s.collected_at AS collectedAt, s.summary,
      s.verification_status AS verificationStatus, s.management_status AS managementStatus
    FROM source_items s LEFT JOIN source_body_cache c ON c.source_id=s.id
    WHERE s.id != ? AND s.management_status != 'archived' AND s.collected_at >= ? AND s.collected_at < ?
      AND (${aliasFilter})
    ORDER BY s.collected_at DESC, s.id DESC LIMIT ?`).all(
      input.currentSourceId, since, input.currentCollectedAt, ...aliases, Math.min(maxSources * 5, 500)
    ) as SourceRow[];
  const candidates: KnowledgeReactivationSource[] = [];
  const skipped: Array<{ sourceId: string; reasonCode: string; reason: string }> = [];
  for (const row of rows) {
    const body = sourceBody(database, row);
    if (!body.body.trim()) {
      skipped.push({ sourceId: row.id, reasonCode: 'NO_BODY', reason: '旧 Source 没有正文或摘要。' });
      continue;
    }
    if (body.body.length > maxBodyChars) {
      skipped.push({ sourceId: row.id, reasonCode: 'BODY_TOO_LARGE', reason: `旧 Source 正文超过 ${maxBodyChars} 字符上限。` });
      continue;
    }
    const hits = matchedAliases([row.title, row.summary ?? '', body.body].join('\n'), aliases);
    if (!hits.length) continue;
    candidates.push(Object.freeze({
      sourceId: row.id, revision: row.revision, title: row.title, originalUrl: row.originalUrl,
      author: row.author, publishedAt: row.publishedAt, collectedAt: row.collectedAt, summary: row.summary,
      verificationStatus: row.verificationStatus, managementStatus: row.managementStatus,
      body: body.body, bodyKind: body.bodyKind, matchedAliases: Object.freeze(hits),
      existingTopicIds: Object.freeze(relatedTopicIds(database, row.id, maxRelationHops))
    }));
    if (candidates.length >= maxSources) break;
  }
  return Object.freeze({ candidates: Object.freeze(candidates), skipped: Object.freeze(skipped) });
}

function parseJsonArray(raw: string | null | undefined): readonly string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? uniqueNonEmpty(value.filter((item): item is string => typeof item === 'string')) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null | undefined): Readonly<Record<string, unknown>> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
  } catch {
    return {};
  }
}

function jobPayload(raw: string): Readonly<Record<string, unknown>> {
  return parseJsonObject(raw);
}

function sourceProjection(database: DatabaseSync, sourceIds: readonly string[]): ReactivatedEvidencePack['sources'] {
  if (!sourceIds.length) return [];
  const rows = database.prepare(`SELECT id,title,author,original_url AS originalUrl,published_at AS publishedAt,
      collected_at AS collectedAt,summary,verification_status AS verificationStatus,revision
    FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')})
    ORDER BY collected_at ASC,id ASC`).all(...sourceIds) as unknown as ReactivatedEvidencePack['sources'];
  return rows;
}

function claimsForSources(database: DatabaseSync, sourceIds: readonly string[], limit: number): ReactivatedEvidencePack['claims'] {
  if (!sourceIds.length) return [];
  const rows = database.prepare(`SELECT nv.note_id AS noteId, nv.id AS versionId, n.canonical_key AS canonicalKey,
      nv.statement, nv.conclusion_status AS conclusionStatus, nv.evidence_level AS evidenceLevel,
      nv.applies_to AS appliesTo, el.evidence_object_id AS evidenceObjectId, el.relation,
      el.excerpt, el.locator
    FROM knowledge_evidence_links el
    JOIN knowledge_note_versions nv ON nv.id=el.knowledge_note_version_id
    JOIN knowledge_notes n ON n.id=nv.note_id
    WHERE el.evidence_object_type='source' AND el.evidence_object_id IN (${sourceIds.map(() => '?').join(',')})
    ORDER BY el.created_at DESC, el.id DESC LIMIT ?`).all(...sourceIds, limit) as unknown as ReactivatedEvidencePack['claims'];
  return rows;
}

/** 由成功 reactivation job 的当前数据库状态构造冻结给 Planner 的跨日证据包。 */
export function buildReactivatedEvidencePack(
  database: DatabaseSync,
  input: KnowledgeReactivationJobInput,
  options: { jobId?: string; maxClaims?: number; maxReceipts?: number } = {}
): ReactivatedEvidencePack {
  const entityRow = database.prepare(`SELECT id,canonical_key AS canonicalKey,canonical_name AS canonicalName,
      aliases_json AS aliasesJson,revision FROM knowledge_entities WHERE id=?`).get(input.entityId) as Record<string, unknown> | undefined;
  const topicRow = database.prepare(`SELECT id,title,revision FROM topics WHERE id=?`).get(input.topicId) as Record<string, unknown> | undefined;
  const wikiRow = topicRow ? database.prepare(`SELECT p.current_version_id AS wikiPageVersionId,
      v.version_number AS wikiVersionNumber
    FROM knowledge_wiki_pages p LEFT JOIN knowledge_wiki_page_versions v ON v.id=p.current_version_id
    WHERE p.subject_type='topic' AND p.subject_id=? AND p.lifecycle='active' LIMIT 1`).get(input.topicId) as Record<string, unknown> | undefined : undefined;
  const sourceIds = [...new Set([input.currentSourceId, input.sourceId])];
  const sources = sourceProjection(database, sourceIds);
  const claims = claimsForSources(database, sourceIds, clamp(options.maxClaims, DEFAULT_REACTIVATION_MAX_CLAIMS, 1, 200));
  const disputes = claims.filter((claim) => claim.conclusionStatus === 'disputed' || claim.relation === 'contradicts');
  const receiptRows = database.prepare(`SELECT id,request_id AS requestId,summary,counts_json AS counts,
      affected_topics_json AS affectedTopics,affected_entities_json AS affectedEntities,
      impact_json AS impact,failures_json AS failures,created_at AS createdAt
    FROM knowledge_update_receipts WHERE workspace_id=(SELECT value FROM app_meta WHERE key='workspace_id')
      AND (impact_json LIKE ? OR impact_json LIKE ?) ORDER BY created_at DESC LIMIT ?`).all(
    `%${input.sourceId}%`, `%${input.currentSourceId}%`, clamp(options.maxReceipts, DEFAULT_REACTIVATION_MAX_RECEIPTS, 1, 50)
  ) as Array<Record<string, unknown>>;
  return Object.freeze({
    ...(options.jobId ? { reactivationJobId: options.jobId } : {}),
    reactivationReason: input.reason,
    entity: entityRow ? Object.freeze({
      id: String(entityRow.id), canonicalKey: String(entityRow.canonicalKey), canonicalName: String(entityRow.canonicalName),
      aliases: Object.freeze(parseJsonArray(String(entityRow.aliasesJson ?? '[]'))), revision: Number(entityRow.revision)
    }) : null,
    topic: topicRow ? Object.freeze({
      id: String(topicRow.id), title: String(topicRow.title), revision: Number(topicRow.revision),
      wikiPageVersionId: wikiRow?.wikiPageVersionId == null ? null : String(wikiRow.wikiPageVersionId),
      wikiVersionNumber: wikiRow?.wikiVersionNumber == null ? null : Number(wikiRow.wikiVersionNumber)
    }) : null,
    sources: Object.freeze(sources), claims: Object.freeze(claims), disputes: Object.freeze(disputes),
    evidenceGaps: Object.freeze(input.evidenceGaps.map((gap) => Object.freeze({ ...gap }))),
    receipts: Object.freeze(receiptRows.map((row) => Object.freeze({
      ...row,
      counts: parseJsonObject(String(row.counts ?? '{}')),
      affectedTopics: parseJsonArray(String(row.affectedTopics ?? '[]')),
      affectedEntities: parseJsonArray(String(row.affectedEntities ?? '[]')),
      impact: parseJsonObject(String(row.impact ?? '{}')),
      failures: parseJsonArray(String(row.failures ?? '[]'))
    })))
  });
}

export function parseKnowledgeReactivationJobInput(raw: string): KnowledgeReactivationJobInput | null {
  const value = jobPayload(raw);
  const required = ['sourceId', 'sourceRevision', 'currentSourceId', 'currentSourceRevision', 'entityId', 'entityRevision', 'topicId', 'reason'];
  if (required.some((key) => typeof value[key] !== 'string' && typeof value[key] !== 'number')) return null;
  const evidenceGaps = Array.isArray(value.evidenceGaps)
    ? value.evidenceGaps.filter((item): item is Readonly<Record<string, unknown>> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const matchedAliases = Array.isArray(value.matchedAliases)
    ? value.matchedAliases.filter((item): item is string => typeof item === 'string')
    : [];
  return Object.freeze({
    sourceId: String(value.sourceId), sourceRevision: Number(value.sourceRevision), currentSourceId: String(value.currentSourceId),
    currentSourceRevision: Number(value.currentSourceRevision), entityId: String(value.entityId), entityRevision: Number(value.entityRevision),
    topicId: String(value.topicId), reason: String(value.reason), matchedAliases: Object.freeze(uniqueNonEmpty(matchedAliases)),
    evidenceGaps: Object.freeze(evidenceGaps)
  });
}

export function listReactivatedEvidencePacks(database: DatabaseSync, options: { limit?: number; since?: string } = {}): readonly ReactivatedEvidencePack[] {
  const limit = clamp(options.limit, 20, 1, 100);
  const rows = database.prepare(`SELECT id,payload_json AS payloadJson FROM jobs
    WHERE kind='knowledge_reactivate_sources' AND status='succeeded' AND (? IS NULL OR finished_at >= ?)
    ORDER BY finished_at DESC,id DESC LIMIT ?`).all(options.since ?? null, options.since ?? null, limit) as Array<{ id: string; payloadJson: string }>;
  const packs: ReactivatedEvidencePack[] = [];
  for (const row of rows) {
    const input = parseKnowledgeReactivationJobInput(row.payloadJson);
    if (input) packs.push(buildReactivatedEvidencePack(database, input, { jobId: row.id }));
  }
  return Object.freeze(packs);
}

export function reactivationJobDedupeKey(input: KnowledgeReactivationJobInput): string {
  return `knowledge_reactivate_sources:${input.entityId}:r${input.entityRevision}:${input.sourceId}:r${input.sourceRevision}:topic:${input.topicId}`;
}
