// WMB-5238：全局知识时间日志投影服务（统一时间日志读模型）。
// Design: WMB-5238 SQLite 内建 Wiki 索引 + 全局时间日志；契约在 src/shared/knowledge-global-log.ts。
//
// 关键语义：
// - 派生读模型：不新增表、不写任何行；条目由既有正式表实时投影：
//   knowledge_change_sets / knowledge_update_receipts / knowledge_wiki_page_versions(+pages) /
//   knowledge_health_issues / knowledge_query_artifacts / source_body_revisions / app_meta 维护 run KV。
//   因此可重建（重算即重建）、幂等（同库同过滤重算结果一致）、非独立真源（SQLite 正式表是唯一真源）；
//   本模块无任何写面：不注册 dispatcher 命令、不触碰 write-guard、不写 operation_log。
// - 历史锚点不漂移：每类事件取源表不可变时间列（created_at / detected_at / resolved_at /
//   startedAt / completedAt）为 time，条目内容只引用该时刻已冻结的字段与不可变版本行；
//   后续更新（health issue 解决、维护 run 推进）只追加新事件，不改写既有条目。
// - 稳定分页：全局序 = (time DESC, id DESC)，id = `${eventType}:${objectId}` 全局唯一；
//   keyset 游标（shared encode/decode）按 (time,id) 前进，跨页插入不重不丢。
// - workspace 隔离：只读调用方传入的当前 data-root DB 句柄（同 ipc-knowledge-flywheel 的
//   readWorkspaceDatabase 边界）；change_set/receipt 为工作空间级聚合（无 scope 列）。
//
// 事件类 → 源表 / 时间锚：
//   change_set            → knowledge_change_sets.created_at
//   receipt               → knowledge_update_receipts.created_at
//   compile               → knowledge_wiki_page_versions.created_at（Wiki 编译/版本提交）
//   lint_detected         → knowledge_health_issues.detected_at
//   lint_resolved         → knowledge_health_issues.resolved_at（resolved_at 非空才出现）
//   maintenance_started   → app_meta 维护 run.startedAt
//   maintenance_completed → app_meta 维护 run.completedAt（completedAt 非空才出现）
//   query                 → knowledge_query_artifacts.created_at（问答写回）
//   source                → source_body_revisions.created_at（来源正文摄取，不可变行）
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeMaintenanceRun } from '../shared/knowledge-maintenance.ts';
import {
  decodeKnowledgeLogCursor,
  encodeKnowledgeLogCursor
} from '../shared/knowledge-global-log.ts';
import type {
  KnowledgeLogEntry,
  KnowledgeLogEventType,
  KnowledgeLogObjectType,
  KnowledgeLogPage,
  KnowledgeLogReadFilter,
  KnowledgeLogRefs,
  KnowledgeLogVersionRefs
} from '../shared/knowledge-global-log.ts';

/**
 * 维护 run 的 app_meta KV 键。
 * 真源：knowledge-maintenance.ts 的 KNOWLEDGE_MAINTENANCE_RUN_KEY（'wmb_knowledge_maintenance_v1'）。
 * 本模块自持同值常量而非导入，原因：knowledge-maintenance.ts 的重模块图（data-changed /
 * business-command / knowledge-backfill / knowledge-health）且该文件由 WMB-5238 触发器 worker
 * 持有编辑权——只读投影不应因宿主模块图变动而脆断；该键为持久化内部标识（非 IPC/契约命名），
 * 若真源变更需与本文件同步修改（两侧同值，测试会钉死）。
 */
const KNOWLEDGE_MAINTENANCE_RUN_KEY = 'wmb_knowledge_maintenance_v1' as const;

export { KNOWLEDGE_MAINTENANCE_RUN_KEY };

// ============================================================
// 错误与固定矩阵
// ============================================================

export class KnowledgeGlobalLogError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'KnowledgeGlobalLogError';
    this.code = code;
    this.details = details;
  }
}

export const KNOWLEDGE_GLOBAL_LOG_ERROR_CODES = Object.freeze([
  'KNOWLEDGE_LOG_FILTER_INVALID',
  'KNOWLEDGE_LOG_CURSOR_INVALID',
  'KNOWLEDGE_LOG_CURSOR_CONFLICT',
  'KNOWLEDGE_LOG_ENTRY_INVALID'
] as const);

const ALL_EVENT_TYPES: readonly KnowledgeLogEventType[] = Object.freeze([
  'change_set', 'receipt', 'compile', 'lint_detected', 'lint_resolved',
  'maintenance_started', 'maintenance_completed', 'query', 'source'
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SCOPE_PATTERN = /^(?:global|lane:[a-z0-9][a-z0-9_-]{0,63})$/;

/** 事件类 → 承载的稳定对象类型（locator kind 与其一致）。 */
function objectTypeForEvent(eventType: KnowledgeLogEventType): KnowledgeLogObjectType {
  switch (eventType) {
    case 'change_set': return 'change_set';
    case 'receipt': return 'receipt';
    case 'compile': return 'wiki_page_version';
    case 'lint_detected':
    case 'lint_resolved': return 'health_issue';
    case 'maintenance_started':
    case 'maintenance_completed': return 'maintenance_run';
    case 'query': return 'query_artifact';
    case 'source': return 'source_revision';
  }
}

/** 事件类是否携带 scope（change_set/receipt 为工作空间级聚合，maintenance/source 无 scope）。 */
function hasScope(eventType: KnowledgeLogEventType): boolean {
  return eventType === 'compile' || eventType === 'lint_detected' || eventType === 'lint_resolved' || eventType === 'query';
}

/** 事件类是否可关联 Topic（topicId 过滤只在这些类上生效）。 */
function hasTopic(eventType: KnowledgeLogEventType): boolean {
  return eventType === 'change_set' || eventType === 'receipt' || eventType === 'compile';
}

// ============================================================
// 过滤归一化
// ============================================================

type Direction = 'newest' | 'older' | 'newer';

type NormalizedFilter = Readonly<{
  eventType: KnowledgeLogEventType | null;
  topicId: string | null;
  objectType: KnowledgeLogObjectType | null;
  objectId: string | null;
  scope: string | null;
  limit: number;
  cursor: { time: string; id: string } | null;
  dir: Direction;
}>;

function normalizeFilter(rawInput: KnowledgeLogReadFilter): NormalizedFilter {
  const value = (rawInput ?? {}) as Readonly<Record<string, unknown>>;
  const limit = Math.min(Math.max(typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.trunc(value.limit) : DEFAULT_LIMIT, 1), MAX_LIMIT);

  let eventType: KnowledgeLogEventType | null = null;
  if (value.eventType !== undefined && value.eventType !== null) {
    if (!ALL_EVENT_TYPES.includes(value.eventType as KnowledgeLogEventType)) {
      throw new KnowledgeGlobalLogError('KNOWLEDGE_LOG_FILTER_INVALID', '非法 eventType。', { eventType: value.eventType });
    }
    eventType = value.eventType as KnowledgeLogEventType;
  }

  let objectType: KnowledgeLogObjectType | null = null;
  if (value.objectType !== undefined && value.objectType !== null) {
    const candidate = String(value.objectType);
    if (!ALL_EVENT_TYPES.some((kind) => objectTypeForEvent(kind) === candidate)) {
      throw new KnowledgeGlobalLogError('KNOWLEDGE_LOG_FILTER_INVALID', '非法 objectType。', { objectType: value.objectType });
    }
    objectType = candidate as KnowledgeLogObjectType;
  }

  const topicId = typeof value.topicId === 'string' && value.topicId.trim() ? value.topicId.trim() : null;
  const objectId = typeof value.objectId === 'string' && value.objectId.trim() ? value.objectId.trim() : null;

  let scope: string | null = null;
  if (value.scope !== undefined && value.scope !== null && String(value.scope).trim()) {
    const candidate = String(value.scope).trim();
    if (!SCOPE_PATTERN.test(candidate)) {
      throw new KnowledgeGlobalLogError('KNOWLEDGE_LOG_FILTER_INVALID', '非法 scope。', { scope: value.scope });
    }
    scope = candidate;
  }

  const hasBefore = typeof value.before === 'string' && value.before.trim() !== '';
  const hasAfter = typeof value.after === 'string' && value.after.trim() !== '';
  if (hasBefore && hasAfter) {
    throw new KnowledgeGlobalLogError('KNOWLEDGE_LOG_CURSOR_CONFLICT', 'before 与 after 游标不能同时使用。');
  }
  let cursor: { time: string; id: string } | null = null;
  let dir: Direction = 'newest';
  if (hasBefore || hasAfter) {
    const decoded = decodeKnowledgeLogCursor(String(hasBefore ? value.before : value.after).trim());
    if (!decoded) {
      throw new KnowledgeGlobalLogError('KNOWLEDGE_LOG_CURSOR_INVALID', '非法分页游标。', { before: hasBefore ? value.before : undefined, after: hasAfter ? value.after : undefined });
    }
    cursor = decoded;
    dir = hasBefore ? 'older' : 'newer';
  }

  return Object.freeze({ eventType, topicId, objectType, objectId, scope, limit, cursor, dir });
}

// ============================================================
// 内部行模型与合并
// ============================================================

type LogRow = Readonly<{
  eventType: KnowledgeLogEventType;
  time: string;
  objectId: string;
  raw: Readonly<Record<string, unknown>>;
}>;

function rowFullId(row: LogRow): string {
  return `${row.eventType}:${row.objectId}`;
}

/** 稳定全序比较：先 time（ISO-8601 字典序 == 时间序），再全量 id（含事件类前缀，全局唯一）。 */
function compareKeys(timeA: string, idA: string, timeB: string, idB: string): number {
  if (timeA < timeB) return -1;
  if (timeA > timeB) return 1;
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
}

function compareRows(a: LogRow, b: LogRow): number {
  return compareKeys(a.time, rowFullId(a), b.time, rowFullId(b));
}

function mergeAsc(streams: readonly (readonly LogRow[])[]): LogRow[] {
  const indexes = streams.map(() => 0);
  const out: LogRow[] = [];
  let active = streams.filter((stream) => stream.length > 0).length;
  while (active > 0) {
    let bestIndex = -1;
    let bestRow: LogRow | null = null;
    for (let index = 0; index < streams.length; index += 1) {
      if (indexes[index] >= streams[index].length) continue;
      const row = streams[index][indexes[index]];
      if (bestRow === null || compareRows(row, bestRow) < 0) {
        bestIndex = index;
        bestRow = row;
      }
    }
    if (bestRow === null) break;
    out.push(bestRow);
    indexes[bestIndex] += 1;
    if (indexes[bestIndex] >= streams[bestIndex].length) active -= 1;
  }
  return out;
}

function mergeDesc(streams: readonly (readonly LogRow[])[]): LogRow[] {
  const indexes = streams.map(() => 0);
  const out: LogRow[] = [];
  let active = streams.filter((stream) => stream.length > 0).length;
  while (active > 0) {
    let bestIndex = -1;
    let bestRow: LogRow | null = null;
    for (let index = 0; index < streams.length; index += 1) {
      if (indexes[index] >= streams[index].length) continue;
      const row = streams[index][indexes[index]];
      if (bestRow === null || compareRows(row, bestRow) > 0) {
        bestIndex = index;
        bestRow = row;
      }
    }
    if (bestRow === null) break;
    out.push(bestRow);
    indexes[bestIndex] += 1;
    if (indexes[bestIndex] >= streams[bestIndex].length) active -= 1;
  }
  return out;
}

// ============================================================
// JSON 解析工具（防御式；坏 JSON 一律降级为空）
// ============================================================

function parseJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

/** business_object_refs 里的来源引用形如 `source:<sourceId>:r<revision>`。 */
function parseSourceRefs(refs: readonly string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('source:') && ref.length > 7) {
      const rest = ref.slice(7);
      const colon = rest.indexOf(':');
      const sourceId = colon >= 0 ? rest.slice(0, colon) : rest;
      if (sourceId && !out.includes(sourceId)) out.push(sourceId);
    }
  }
  return out;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ============================================================
// 统一 SQL 游标查询（每源一查，limit+1 判定 hasMore）
// ============================================================

type SourceQuery = Readonly<{
  select: string;
  from: string;
  timeCol: string;
  idExpr: string;
}>;

function runSourceQuery(
  database: DatabaseSync,
  query: SourceQuery,
  filters: { clause: string; args: readonly (string | number)[] },
  cursor: { time: string; id: string } | null,
  dir: Direction,
  limit: number
): Array<Record<string, unknown>> {
  const parts: string[] = [];
  const args: Array<string | number> = [...filters.args];
  if (filters.clause) parts.push(filters.clause);
  if (cursor) {
    const cmp = dir === 'newer' ? '>' : '<';
    parts.push(`(${query.timeCol} ${cmp} ? OR (${query.timeCol} = ? AND ${query.idExpr} ${cmp} ?))`);
    args.push(cursor.time, cursor.time, cursor.id);
  }
  const whereSql = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  const order = dir === 'newer' ? 'ASC' : 'DESC';
  const sqlText = `${query.select} ${query.from}${whereSql} ORDER BY ${query.timeCol} ${order}, ${query.idExpr} ${order} LIMIT ?`;
  return database.prepare(sqlText).all(...args, limit) as Array<Record<string, unknown>>;
}

// ============================================================
// 各事件类查询（filters 只含过滤条件；游标与排序由 runSourceQuery 统一处理）
// ============================================================

function changeSetQuery(database: DatabaseSync, filter: NormalizedFilter): LogRow[] {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  if (filter.objectId) {
    clause.push('cs.id = ?');
    args.push(filter.objectId);
  }
  if (filter.topicId) {
    clause.push(`(EXISTS (SELECT 1 FROM knowledge_note_versions nv JOIN json_each(nv.adopted_topic_ids_json) jt ON jt.value = ? WHERE nv.change_set_id = cs.id)
      OR EXISTS (SELECT 1 FROM knowledge_wiki_page_versions wpv JOIN knowledge_wiki_pages wp ON wp.id = wpv.page_id
        WHERE wpv.change_set_id = cs.id AND wp.subject_type = 'topic' AND wp.subject_id = ?))`);
    args.push(filter.topicId, filter.topicId);
  }
  const rows = runSourceQuery(database, {
    select: `SELECT cs.id, cs.workspace_id AS workspaceId, cs.request_id AS requestId, cs.reason,
      cs.trigger_source AS triggerSource, cs.resolution_mode AS resolutionMode,
      cs.created_by AS createdBy, cs.created_at AS createdAt`,
    from: 'FROM knowledge_change_sets cs',
    timeCol: 'cs.created_at',
    idExpr: `'change_set:' || cs.id`
  }, { clause: clause.join(' AND '), args }, filter.cursor, filter.dir, filter.limit + 1);
  return rows.map((row) => ({
    eventType: 'change_set' as const,
    time: String(row.createdAt ?? ''),
    objectId: String(row.id ?? ''),
    raw: row
  }));
}

function receiptQuery(database: DatabaseSync, filter: NormalizedFilter): LogRow[] {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  if (filter.objectId) {
    clause.push('rc.id = ?');
    args.push(filter.objectId);
  }
  if (filter.topicId) {
    clause.push('EXISTS (SELECT 1 FROM json_each(rc.affected_topics_json) jt WHERE jt.value = ?)');
    args.push(filter.topicId);
  }
  const rows = runSourceQuery(database, {
    select: `SELECT rc.id, rc.workspace_id AS workspaceId, rc.change_set_id AS changeSetId, rc.trigger_type AS triggerType,
      rc.request_id AS requestId, rc.summary, rc.affected_topics_json AS affectedTopicsJson,
      rc.affected_entities_json AS affectedEntitiesJson, rc.wiki_page_versions_json AS wikiPageVersionsJson,
      rc.impact_json AS impactJson, rc.created_by AS createdBy, rc.created_at AS createdAt`,
    from: 'FROM knowledge_update_receipts rc',
    timeCol: 'rc.created_at',
    idExpr: `'receipt:' || rc.id`
  }, { clause: clause.join(' AND '), args }, filter.cursor, filter.dir, filter.limit + 1);
  return rows.map((row) => ({
    eventType: 'receipt' as const,
    time: String(row.createdAt ?? ''),
    objectId: String(row.id ?? ''),
    raw: row
  }));
}

function compileQuery(database: DatabaseSync, filter: NormalizedFilter): LogRow[] {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  if (filter.objectId) {
    clause.push('wpv.id = ?');
    args.push(filter.objectId);
  }
  if (filter.scope) {
    clause.push('wp.scope = ?');
    args.push(filter.scope);
  }
  if (filter.topicId) {
    clause.push(`((wp.subject_type = 'topic' AND wp.subject_id = ?)
      OR EXISTS (SELECT 1 FROM json_each(wpv.adopted_note_version_ids_json) ja
        JOIN knowledge_note_versions nv ON nv.id = ja.value
        JOIN json_each(nv.adopted_topic_ids_json) jt ON jt.value = ?))`);
    args.push(filter.topicId, filter.topicId);
  }
  const rows = runSourceQuery(database, {
    select: `SELECT wpv.id, wpv.page_id AS pageId, wpv.version_number AS versionNumber, wpv.title,
      wpv.adopted_note_version_ids_json AS adoptedNoteVersionIdsJson,
      wpv.business_object_refs_json AS businessObjectRefsJson,
      wpv.change_summary AS changeSummary, wpv.compile_reason AS compileReason,
      wpv.change_set_id AS changeSetId, wpv.creator_nature AS createdBy, wpv.created_at AS createdAt,
      wp.scope, wp.subject_type AS subjectType, wp.subject_id AS subjectId, wp.title AS pageTitle`,
    from: 'FROM knowledge_wiki_page_versions wpv JOIN knowledge_wiki_pages wp ON wp.id = wpv.page_id',
    timeCol: 'wpv.created_at',
    idExpr: `'compile:' || wpv.id`
  }, { clause: clause.join(' AND '), args }, filter.cursor, filter.dir, filter.limit + 1);
  return rows.map((row) => ({
    eventType: 'compile' as const,
    time: String(row.createdAt ?? ''),
    objectId: String(row.id ?? ''),
    raw: row
  }));
}

function lintRows(database: DatabaseSync, filter: NormalizedFilter, resolved: boolean): LogRow[] {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  if (filter.objectId) {
    clause.push('hi.id = ?');
    args.push(filter.objectId);
  }
  if (filter.scope) {
    clause.push('hi.scope = ?');
    args.push(filter.scope);
  }
  if (resolved) {
    clause.push('hi.resolved_at IS NOT NULL');
  }
  const timeCol = resolved ? 'hi.resolved_at' : 'hi.detected_at';
  const eventType: KnowledgeLogEventType = resolved ? 'lint_resolved' : 'lint_detected';
  const rows = runSourceQuery(database, {
    select: `SELECT hi.id, hi.scope, hi.issue_type AS issueType, hi.affected_object_type AS affectedObjectType,
      hi.affected_object_id AS affectedObjectId, hi.severity, hi.evidence_json AS evidenceJson,
      hi.suggested_action AS suggestedAction, hi.status, hi.resolution_note AS resolutionNote,
      hi.resolved_change_set_id AS resolvedChangeSetId, hi.detected_at AS detectedAt, hi.resolved_at AS resolvedAt`,
    from: 'FROM knowledge_health_issues hi',
    timeCol,
    idExpr: `'${eventType}:' || hi.id`
  }, { clause: clause.join(' AND '), args }, filter.cursor, filter.dir, filter.limit + 1);
  return rows.map((row) => ({
    eventType,
    time: String(resolved ? row.resolvedAt : row.detectedAt ?? ''),
    objectId: String(row.id ?? ''),
    raw: row
  }));
}

function queryArtifactRows(database: DatabaseSync, filter: NormalizedFilter): LogRow[] {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  if (filter.objectId) {
    clause.push('qa.id = ?');
    args.push(filter.objectId);
  }
  if (filter.scope) {
    clause.push('qa.scope = ?');
    args.push(filter.scope);
  }
  const rows = runSourceQuery(database, {
    select: `SELECT qa.id, qa.scope, qa.workspace_id AS workspaceId, qa.request_id AS requestId, qa.question,
      qa.answer_summary AS answerSummary, qa.write_back_decision AS writeBackDecision, qa.skip_reason AS skipReason,
      qa.change_set_id AS changeSetId, qa.receipt_id AS receiptId,
      qa.read_wiki_version_ids_json AS readWikiVersionIdsJson, qa.read_note_version_ids_json AS readNoteVersionIdsJson,
      qa.created_by AS createdBy, qa.created_at AS createdAt`,
    from: 'FROM knowledge_query_artifacts qa',
    timeCol: 'qa.created_at',
    idExpr: `'query:' || qa.id`
  }, { clause: clause.join(' AND '), args }, filter.cursor, filter.dir, filter.limit + 1);
  return rows.map((row) => ({
    eventType: 'query' as const,
    time: String(row.createdAt ?? ''),
    objectId: String(row.id ?? ''),
    raw: row
  }));
}

function sourceRows(database: DatabaseSync, filter: NormalizedFilter): LogRow[] {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  if (filter.objectId) {
    clause.push('sbr.id = ?');
    args.push(filter.objectId);
  }
  const rows = runSourceQuery(database, {
    select: `SELECT sbr.id, sbr.source_id AS sourceId, sbr.url, sbr.status, sbr.content_type AS contentType,
      sbr.extracted_chars AS extractedChars, sbr.error_message AS errorMessage,
      sbr.previous_revision_id AS previousRevisionId, sbr.created_at AS createdAt`,
    from: 'FROM source_body_revisions sbr',
    timeCol: 'sbr.created_at',
    idExpr: `'source:' || sbr.id`
  }, { clause: clause.join(' AND '), args }, filter.cursor, filter.dir, filter.limit + 1);
  return rows.map((row) => ({
    eventType: 'source' as const,
    time: String(row.createdAt ?? ''),
    objectId: String(row.id ?? ''),
    raw: row
  }));
}

function readMaintenanceRun(database: DatabaseSync): KnowledgeMaintenanceRun | null {
  try {
    const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(KNOWLEDGE_MAINTENANCE_RUN_KEY) as { value?: string } | undefined;
    if (!row || typeof row.value !== 'string' || !row.value) return null;
    const parsed = JSON.parse(row.value) as Partial<KnowledgeMaintenanceRun>;
    const config = parsed?.config as Partial<KnowledgeMaintenanceRun['config']> | undefined;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.runId !== 'string' || !parsed.runId || typeof parsed.startedAt !== 'string') return null;
    if (!config || typeof config.batchLimit !== 'number' || typeof config.maxTopicsPerSource !== 'number' || typeof config.stallLimit !== 'number') return null;
    return parsed as KnowledgeMaintenanceRun;
  } catch {
    return null;
  }
}

/** 维护 run 至多两行（started + completed）；游标/排序在 JS 内处理（KV 单行，无 SQL 源）。 */
function maintenanceRows(database: DatabaseSync, filter: NormalizedFilter): LogRow[] {
  const run = readMaintenanceRun(database);
  if (!run) return [];
  if (filter.objectId && filter.objectId !== run.runId) return [];
  const rows: LogRow[] = [
    { eventType: 'maintenance_started', time: run.startedAt, objectId: run.runId, raw: run as unknown as Record<string, unknown> }
  ];
  if (run.completedAt) {
    rows.push({ eventType: 'maintenance_completed', time: run.completedAt, objectId: run.runId, raw: run as unknown as Record<string, unknown> });
  }
  const filtered = rows.filter((row) => {
    if (!filter.cursor) return true;
    const cmp = compareKeys(row.time, rowFullId(row), filter.cursor.time, filter.cursor.id);
    if (filter.dir === 'newer') return cmp > 0;
    if (filter.dir === 'older') return cmp < 0;
    return true;
  });
  filtered.sort((a, b) => (filter.dir === 'newer' ? compareKeys(a.time, rowFullId(a), b.time, rowFullId(b)) : -compareKeys(a.time, rowFullId(a), b.time, rowFullId(b))));
  return filtered.slice(0, filter.limit + 1);
}

/** 各源行计数（过滤一致，不含游标；用于 total）。 */
function countRows(database: DatabaseSync, filter: NormalizedFilter): Map<KnowledgeLogEventType, number> {
  const counts = new Map<KnowledgeLogEventType, number>();
  const active = activeEventTypes(filter);
  for (const eventType of active) {
    if (eventType === 'maintenance_started' || eventType === 'maintenance_completed') {
      const run = readMaintenanceRun(database);
      if (!run) { counts.set(eventType, 0); continue; }
      if (filter.objectId && filter.objectId !== run.runId) { counts.set(eventType, 0); continue; }
      let count = 1;
      if (eventType === 'maintenance_completed' && !run.completedAt) count = 0;
      counts.set(eventType, count);
      continue;
    }
    const sql = countSqlFor(eventType, filter);
    if (!sql) { counts.set(eventType, 0); continue; }
    const row = database.prepare(sql.text).get(...sql.args) as { count: number };
    counts.set(eventType, Number(row.count));
  }
  return counts;
}

function countSqlFor(eventType: KnowledgeLogEventType, filter: NormalizedFilter): { text: string; args: Array<string | number> } | null {
  const clause: string[] = [];
  const args: Array<string | number> = [];
  let from = '';
  switch (eventType) {
    case 'change_set': {
      from = 'FROM knowledge_change_sets cs';
      if (filter.objectId) { clause.push('cs.id = ?'); args.push(filter.objectId); }
      if (filter.topicId) {
        clause.push(`(EXISTS (SELECT 1 FROM knowledge_note_versions nv JOIN json_each(nv.adopted_topic_ids_json) jt ON jt.value = ? WHERE nv.change_set_id = cs.id)
          OR EXISTS (SELECT 1 FROM knowledge_wiki_page_versions wpv JOIN knowledge_wiki_pages wp ON wp.id = wpv.page_id
            WHERE wpv.change_set_id = cs.id AND wp.subject_type = 'topic' AND wp.subject_id = ?))`);
        args.push(filter.topicId, filter.topicId);
      }
      break;
    }
    case 'receipt': {
      from = 'FROM knowledge_update_receipts rc';
      if (filter.objectId) { clause.push('rc.id = ?'); args.push(filter.objectId); }
      if (filter.topicId) { clause.push('EXISTS (SELECT 1 FROM json_each(rc.affected_topics_json) jt WHERE jt.value = ?)'); args.push(filter.topicId); }
      break;
    }
    case 'compile': {
      from = 'FROM knowledge_wiki_page_versions wpv JOIN knowledge_wiki_pages wp ON wp.id = wpv.page_id';
      if (filter.objectId) { clause.push('wpv.id = ?'); args.push(filter.objectId); }
      if (filter.scope) { clause.push('wp.scope = ?'); args.push(filter.scope); }
      if (filter.topicId) {
        clause.push(`((wp.subject_type = 'topic' AND wp.subject_id = ?)
          OR EXISTS (SELECT 1 FROM json_each(wpv.adopted_note_version_ids_json) ja
            JOIN knowledge_note_versions nv ON nv.id = ja.value
            JOIN json_each(nv.adopted_topic_ids_json) jt ON jt.value = ?))`);
        args.push(filter.topicId, filter.topicId);
      }
      break;
    }
    case 'lint_detected':
    case 'lint_resolved': {
      from = 'FROM knowledge_health_issues hi';
      if (filter.objectId) { clause.push('hi.id = ?'); args.push(filter.objectId); }
      if (filter.scope) { clause.push('hi.scope = ?'); args.push(filter.scope); }
      if (eventType === 'lint_resolved') clause.push('hi.resolved_at IS NOT NULL');
      break;
    }
    case 'query': {
      from = 'FROM knowledge_query_artifacts qa';
      if (filter.objectId) { clause.push('qa.id = ?'); args.push(filter.objectId); }
      if (filter.scope) { clause.push('qa.scope = ?'); args.push(filter.scope); }
      break;
    }
    case 'source': {
      from = 'FROM source_body_revisions sbr';
      if (filter.objectId) { clause.push('sbr.id = ?'); args.push(filter.objectId); }
      break;
    }
    default:
      return null;
  }
  const whereSql = clause.length ? ` WHERE ${clause.join(' AND ')}` : '';
  return { text: `SELECT count(*) AS count ${from}${whereSql}`, args };
}

/** 按 eventType/objectType/scope/topic 过滤后仍参与查询的事件类集合。 */
function activeEventTypes(filter: NormalizedFilter): KnowledgeLogEventType[] {
  let kinds = filter.eventType ? [filter.eventType] : [...ALL_EVENT_TYPES];
  if (filter.objectType) kinds = kinds.filter((kind) => objectTypeForEvent(kind) === filter.objectType);
  if (filter.scope) kinds = kinds.filter(hasScope);
  if (filter.topicId) kinds = kinds.filter(hasTopic);
  return kinds;
}

function fetchRows(database: DatabaseSync, filter: NormalizedFilter): Map<KnowledgeLogEventType, LogRow[]> {
  const map = new Map<KnowledgeLogEventType, LogRow[]>();
  for (const eventType of activeEventTypes(filter)) {
    let rows: LogRow[];
    switch (eventType) {
      case 'change_set': rows = changeSetQuery(database, filter); break;
      case 'receipt': rows = receiptQuery(database, filter); break;
      case 'compile': rows = compileQuery(database, filter); break;
      case 'lint_detected': rows = lintRows(database, filter, false); break;
      case 'lint_resolved': rows = lintRows(database, filter, true); break;
      case 'maintenance_started':
      case 'maintenance_completed': rows = maintenanceRows(database, filter).filter((row) => row.eventType === eventType); break;
      case 'query': rows = queryArtifactRows(database, filter); break;
      case 'source': rows = sourceRows(database, filter); break;
    }
    map.set(eventType, rows);
  }
  return map;
}

// ============================================================
// 批量富化（只对最终页内行执行；一次 IN 查询，有界）
// ============================================================

type ChangeSetEnrichment = Readonly<{
  receiptByCs: Map<string, { receiptId: string; sourceIds: readonly string[] }>;
  noteVersionsByCs: Map<string, ReadonlyArray<{ versionId: string; noteId: string }>>;
  wikiPageVersionsByCs: Map<string, ReadonlyArray<{ versionId: string; pageId: string }>>;
  topicsByCs: Map<string, readonly string[]>;
}>;

function placeholder(ids: readonly string[]): string {
  return ids.map(() => '?').join(',');
}

function enrichChangeSets(database: DatabaseSync, rows: readonly LogRow[]): ChangeSetEnrichment {
  const receiptByCs = new Map<string, { receiptId: string; sourceIds: readonly string[] }>();
  const noteVersionsByCs = new Map<string, Array<{ versionId: string; noteId: string }>>();
  const wikiPageVersionsByCs = new Map<string, Array<{ versionId: string; pageId: string }>>();
  const topicsByCs = new Map<string, string[]>();
  const ids = rows.map((row) => row.objectId);
  if (ids.length === 0) return { receiptByCs, noteVersionsByCs, wikiPageVersionsByCs, topicsByCs };
  const ph = placeholder(ids);

  for (const row of database.prepare(
    `SELECT id, change_set_id AS changeSetId, impact_json AS impactJson FROM knowledge_update_receipts WHERE change_set_id IN (${ph})`
  ).all(...ids) as Array<Record<string, unknown>>) {
    const impact = parseJsonObject(row.impactJson);
    const sourceIds = typeof impact.sourceId === 'string' && impact.sourceId ? [impact.sourceId] : [];
    receiptByCs.set(String(row.changeSetId), { receiptId: String(row.id), sourceIds });
  }

  for (const row of database.prepare(
    `SELECT id, note_id AS noteId, change_set_id AS changeSetId FROM knowledge_note_versions WHERE change_set_id IN (${ph})`
  ).all(...ids) as Array<Record<string, unknown>>) {
    const list = noteVersionsByCs.get(String(row.changeSetId)) ?? [];
    list.push({ versionId: String(row.id), noteId: String(row.noteId) });
    noteVersionsByCs.set(String(row.changeSetId), list);
  }

  for (const row of database.prepare(
    `SELECT id, page_id AS pageId, change_set_id AS changeSetId FROM knowledge_wiki_page_versions WHERE change_set_id IN (${ph})`
  ).all(...ids) as Array<Record<string, unknown>>) {
    const list = wikiPageVersionsByCs.get(String(row.changeSetId)) ?? [];
    list.push({ versionId: String(row.id), pageId: String(row.pageId) });
    wikiPageVersionsByCs.set(String(row.changeSetId), list);
  }

  for (const row of database.prepare(
    `SELECT nv.change_set_id AS owner, jt.value AS topicId FROM knowledge_note_versions nv
      JOIN json_each(nv.adopted_topic_ids_json) jt WHERE nv.change_set_id IN (${ph})
     UNION
     SELECT wpv.change_set_id AS owner, wp.subject_id AS topicId FROM knowledge_wiki_page_versions wpv
      JOIN knowledge_wiki_pages wp ON wp.id = wpv.page_id
      WHERE wpv.change_set_id IN (${ph}) AND wp.subject_type = 'topic' AND wp.subject_id IS NOT NULL`
  ).all(...ids, ...ids) as Array<Record<string, unknown>>) {
    if (row.owner === null || row.owner === undefined) continue;
    const list = topicsByCs.get(String(row.owner)) ?? [];
    const topicId = String(row.topicId);
    if (topicId && !list.includes(topicId)) list.push(topicId);
    topicsByCs.set(String(row.owner), list);
  }

  return { receiptByCs, noteVersionsByCs, wikiPageVersionsByCs, topicsByCs };
}

type CompileEnrichment = Readonly<{
  topicsByVersion: Map<string, readonly string[]>;
  noteIdsByVersion: Map<string, readonly string[]>;
}>;

function enrichCompile(database: DatabaseSync, rows: readonly LogRow[]): CompileEnrichment {
  const topicsByVersion = new Map<string, string[]>();
  const noteIdsByVersion = new Map<string, string[]>();
  const ids = rows.map((row) => row.objectId);
  if (ids.length === 0) return { topicsByVersion, noteIdsByVersion };
  const ph = placeholder(ids);
  for (const row of database.prepare(
    `SELECT wpv.id AS owner, jt.value AS topicId FROM knowledge_wiki_page_versions wpv
      JOIN json_each(wpv.adopted_note_version_ids_json) ja
      JOIN knowledge_note_versions nv ON nv.id = ja.value
      JOIN json_each(nv.adopted_topic_ids_json) jt WHERE wpv.id IN (${ph})`
  ).all(...ids) as Array<Record<string, unknown>>) {
    const list = topicsByVersion.get(String(row.owner)) ?? [];
    const topicId = String(row.topicId);
    if (topicId && !list.includes(topicId)) list.push(topicId);
    topicsByVersion.set(String(row.owner), list);
  }
  for (const row of database.prepare(
    `SELECT wpv.id AS owner, nv.note_id AS noteId FROM knowledge_wiki_page_versions wpv
      JOIN json_each(wpv.adopted_note_version_ids_json) ja
      JOIN knowledge_note_versions nv ON nv.id = ja.value WHERE wpv.id IN (${ph})`
  ).all(...ids) as Array<Record<string, unknown>>) {
    const list = noteIdsByVersion.get(String(row.owner)) ?? [];
    const noteId = String(row.noteId);
    if (noteId && !list.includes(noteId)) list.push(noteId);
    noteIdsByVersion.set(String(row.owner), list);
  }
  return { topicsByVersion, noteIdsByVersion };
}

type QueryEnrichment = Readonly<{
  noteIdsByVersion: Map<string, string>;
  wikiPageIdsByVersion: Map<string, string>;
}>;

function enrichQuery(database: DatabaseSync, rows: readonly LogRow[]): QueryEnrichment {
  const noteIdsByVersion = new Map<string, string>();
  const wikiPageIdsByVersion = new Map<string, string>();
  const noteVersionIds: string[] = [];
  const wikiVersionIds: string[] = [];
  for (const row of rows) {
    for (const versionId of parseStringArray(row.raw.readNoteVersionIdsJson)) {
      if (!noteVersionIds.includes(versionId)) noteVersionIds.push(versionId);
    }
    for (const versionId of parseStringArray(row.raw.readWikiVersionIdsJson)) {
      if (!wikiVersionIds.includes(versionId)) wikiVersionIds.push(versionId);
    }
  }
  if (noteVersionIds.length > 0) {
    const ph = placeholder(noteVersionIds);
    for (const row of database.prepare(`SELECT id, note_id AS noteId FROM knowledge_note_versions WHERE id IN (${ph})`).all(...noteVersionIds) as Array<Record<string, unknown>>) {
      noteIdsByVersion.set(String(row.id), String(row.noteId));
    }
  }
  if (wikiVersionIds.length > 0) {
    const ph = placeholder(wikiVersionIds);
    for (const row of database.prepare(`SELECT id, page_id AS pageId FROM knowledge_wiki_page_versions WHERE id IN (${ph})`).all(...wikiVersionIds) as Array<Record<string, unknown>>) {
      wikiPageIdsByVersion.set(String(row.id), String(row.pageId));
    }
  }
  return { noteIdsByVersion, wikiPageIdsByVersion };
}

// ============================================================
// 条目构建（纯函数；只读 raw + 富化映射，产出不可变 JSON）
// ============================================================

function emptyVersionRefs(): KnowledgeLogVersionRefs {
  return Object.freeze({
    changeSetId: null, receiptId: null, wikiPageId: null, wikiPageVersionIds: [],
    noteVersionIds: [], healthIssueId: null, sourceId: null, sourceRevisionId: null,
    previousSourceRevisionId: null, maintenanceRunId: null, reportId: null
  });
}

function emptyRefs(): KnowledgeLogRefs {
  return Object.freeze({ topicIds: [], entityIds: [], sourceIds: [], noteIds: [], wikiPageIds: [] });
}

function buildChangeSetEntry(raw: Readonly<Record<string, unknown>>, enrichment: ChangeSetEnrichment): KnowledgeLogEntry {
  const csId = String(raw.id ?? '');
  const receipt = enrichment.receiptByCs.get(csId) ?? null;
  const noteVersions = enrichment.noteVersionsByCs.get(csId) ?? [];
  const pageVersions = enrichment.wikiPageVersionsByCs.get(csId) ?? [];
  const noteIds: string[] = [];
  const wikiPageIds: string[] = [];
  for (const version of noteVersions) if (!noteIds.includes(version.noteId)) noteIds.push(version.noteId);
  for (const version of pageVersions) if (!wikiPageIds.includes(version.pageId)) wikiPageIds.push(version.pageId);
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `change_set:${csId}`,
    eventType: 'change_set',
    time: String(raw.createdAt ?? ''),
    objectType: 'change_set',
    objectId: csId,
    title: `知识变更集 · ${String(raw.triggerSource ?? '')}`,
    summary: String(raw.reason ?? ''),
    scope: null,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
    actor: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    versionRefs: Object.freeze({
      ...versionRefs,
      changeSetId: csId,
      receiptId: receipt?.receiptId ?? null,
      noteVersionIds: Object.freeze(noteVersions.map((version) => version.versionId)),
      wikiPageVersionIds: Object.freeze(pageVersions.map((version) => version.versionId))
    }),
    refs: Object.freeze({
      ...emptyRefs(),
      topicIds: Object.freeze(enrichment.topicsByCs.get(csId) ?? []),
      sourceIds: Object.freeze(receipt?.sourceIds ?? []),
      noteIds: Object.freeze(noteIds),
      wikiPageIds: Object.freeze(wikiPageIds)
    }),
    locator: Object.freeze({ kind: 'change_set', id: csId })
  });
}

function buildReceiptEntry(raw: Readonly<Record<string, unknown>>): KnowledgeLogEntry {
  const receiptId = String(raw.id ?? '');
  const topicIds = parseStringArray(raw.affectedTopicsJson);
  const entityIds = parseStringArray(raw.affectedEntitiesJson);
  const wikiPageVersionIds = parseStringArray(raw.wikiPageVersionsJson);
  const impact = parseJsonObject(raw.impactJson);
  const sourceIds = typeof impact.sourceId === 'string' && impact.sourceId ? [impact.sourceId] : [];
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `receipt:${receiptId}`,
    eventType: 'receipt',
    time: String(raw.createdAt ?? ''),
    objectType: 'receipt',
    objectId: receiptId,
    title: `知识更新回执 · ${String(raw.triggerType ?? '')}`,
    summary: String(raw.summary ?? ''),
    scope: null,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
    actor: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    versionRefs: Object.freeze({
      ...versionRefs,
      changeSetId: typeof raw.changeSetId === 'string' ? raw.changeSetId : null,
      receiptId,
      wikiPageVersionIds: Object.freeze(wikiPageVersionIds)
    }),
    refs: Object.freeze({
      ...emptyRefs(),
      topicIds: Object.freeze(topicIds),
      entityIds: Object.freeze(entityIds),
      sourceIds: Object.freeze(sourceIds)
    }),
    locator: Object.freeze({ kind: 'receipt', id: receiptId })
  });
}

function buildCompileEntry(raw: Readonly<Record<string, unknown>>, enrichment: CompileEnrichment): KnowledgeLogEntry {
  const versionId = String(raw.id ?? '');
  const pageId = String(raw.pageId ?? '');
  const noteVersionIds = parseStringArray(raw.adoptedNoteVersionIdsJson);
  const noteIds = [...enrichment.noteIdsByVersion.get(versionId) ?? []];
  const topicIds: string[] = [];
  if (raw.subjectType === 'topic' && typeof raw.subjectId === 'string' && raw.subjectId && !topicIds.includes(raw.subjectId)) {
    topicIds.push(raw.subjectId);
  }
  for (const topicId of enrichment.topicsByVersion.get(versionId) ?? []) {
    if (!topicIds.includes(topicId)) topicIds.push(topicId);
  }
  const sourceIds = parseSourceRefs(parseStringArray(raw.businessObjectRefsJson));
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `compile:${versionId}`,
    eventType: 'compile',
    time: String(raw.createdAt ?? ''),
    objectType: 'wiki_page_version',
    objectId: versionId,
    title: `Wiki 编译 · ${String(raw.pageTitle ?? '')} v${String(raw.versionNumber ?? '')}`,
    summary: String(raw.changeSummary ?? raw.compileReason ?? ''),
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    workspaceId: null,
    actor: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    versionRefs: Object.freeze({
      ...versionRefs,
      changeSetId: typeof raw.changeSetId === 'string' ? raw.changeSetId : null,
      wikiPageId: pageId,
      wikiPageVersionIds: Object.freeze([versionId]),
      noteVersionIds: Object.freeze(noteVersionIds)
    }),
    refs: Object.freeze({
      ...emptyRefs(),
      topicIds: Object.freeze(topicIds),
      sourceIds: Object.freeze(sourceIds),
      noteIds: Object.freeze(noteIds),
      wikiPageIds: Object.freeze([pageId])
    }),
    locator: Object.freeze({ kind: 'wiki_page_version', id: versionId })
  });
}

function affectedRefs(objectType: unknown, objectId: unknown): KnowledgeLogRefs {
  const refs = emptyRefs();
  const id = typeof objectId === 'string' && objectId ? objectId : null;
  if (!id) return refs;
  switch (objectType) {
    case 'source': return Object.freeze({ ...refs, sourceIds: Object.freeze([id]) });
    case 'topic': return Object.freeze({ ...refs, topicIds: Object.freeze([id]) });
    case 'knowledge_entity': return Object.freeze({ ...refs, entityIds: Object.freeze([id]) });
    case 'knowledge_note':
    case 'knowledge_note_version': return Object.freeze({ ...refs, noteIds: Object.freeze([id]) });
    case 'wiki_page':
    case 'wiki_page_version': return Object.freeze({ ...refs, wikiPageIds: Object.freeze([id]) });
    default: return refs;
  }
}

function buildLintDetectedEntry(raw: Readonly<Record<string, unknown>>): KnowledgeLogEntry {
  const issueId = String(raw.id ?? '');
  const parts: string[] = [String(raw.severity ?? '')];
  if (raw.affectedObjectType && raw.affectedObjectId) {
    parts.push(`${String(raw.affectedObjectType)}:${String(raw.affectedObjectId)}`);
  }
  if (raw.suggestedAction) parts.push(String(raw.suggestedAction));
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `lint_detected:${issueId}`,
    eventType: 'lint_detected',
    time: String(raw.detectedAt ?? ''),
    objectType: 'health_issue',
    objectId: issueId,
    title: `Lint 检测 · ${String(raw.issueType ?? '')}`,
    summary: parts.filter(Boolean).join(' · '),
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    workspaceId: null,
    actor: null,
    versionRefs: Object.freeze({ ...versionRefs, healthIssueId: issueId }),
    refs: affectedRefs(raw.affectedObjectType, raw.affectedObjectId),
    locator: Object.freeze({ kind: 'health_issue', id: issueId })
  });
}

function buildLintResolvedEntry(raw: Readonly<Record<string, unknown>>): KnowledgeLogEntry {
  const issueId = String(raw.id ?? '');
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `lint_resolved:${issueId}`,
    eventType: 'lint_resolved',
    time: String(raw.resolvedAt ?? ''),
    objectType: 'health_issue',
    objectId: issueId,
    title: `Lint 解决 · ${String(raw.issueType ?? '')}`,
    summary: String(raw.resolutionNote ?? `状态 → ${String(raw.status ?? '')}`),
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    workspaceId: null,
    actor: null,
    versionRefs: Object.freeze({
      ...versionRefs,
      changeSetId: typeof raw.resolvedChangeSetId === 'string' ? raw.resolvedChangeSetId : null,
      healthIssueId: issueId
    }),
    refs: affectedRefs(raw.affectedObjectType, raw.affectedObjectId),
    locator: Object.freeze({ kind: 'health_issue', id: issueId })
  });
}

function buildMaintenanceStartedEntry(run: KnowledgeMaintenanceRun): KnowledgeLogEntry {
  const config = run.config;
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `maintenance_started:${run.runId}`,
    eventType: 'maintenance_started',
    time: run.startedAt,
    objectType: 'maintenance_run',
    objectId: run.runId,
    title: '全库维护启动',
    summary: `run ${run.runId} · batch=${config.batchLimit}/maxTopics=${config.maxTopicsPerSource}/stall=${config.stallLimit}`,
    scope: null,
    workspaceId: run.workspaceId ?? null,
    actor: null,
    versionRefs: Object.freeze({ ...versionRefs, maintenanceRunId: run.runId }),
    refs: emptyRefs(),
    locator: Object.freeze({ kind: 'maintenance_run', id: run.runId })
  });
}

function buildMaintenanceCompletedEntry(run: KnowledgeMaintenanceRun): KnowledgeLogEntry {
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `maintenance_completed:${run.runId}`,
    eventType: 'maintenance_completed',
    time: String(run.completedAt ?? ''),
    objectType: 'maintenance_run',
    objectId: run.runId,
    title: '全库维护完成',
    summary: `run ${run.runId}${run.reportId ? ` · 报告 ${run.reportId}` : ''}`,
    scope: null,
    workspaceId: run.workspaceId ?? null,
    actor: null,
    versionRefs: Object.freeze({ ...versionRefs, maintenanceRunId: run.runId, reportId: run.reportId ?? null }),
    refs: emptyRefs(),
    locator: Object.freeze({ kind: 'maintenance_run', id: run.runId })
  });
}

function buildQueryEntry(raw: Readonly<Record<string, unknown>>, enrichment: QueryEnrichment): KnowledgeLogEntry {
  const artifactId = String(raw.id ?? '');
  const noteVersionIds = parseStringArray(raw.readNoteVersionIdsJson);
  const wikiPageVersionIds = parseStringArray(raw.readWikiVersionIdsJson);
  const noteIds: string[] = [];
  const wikiPageIds: string[] = [];
  for (const versionId of noteVersionIds) {
    const noteId = enrichment.noteIdsByVersion.get(versionId);
    if (noteId && !noteIds.includes(noteId)) noteIds.push(noteId);
  }
  for (const versionId of wikiPageVersionIds) {
    const pageId = enrichment.wikiPageIdsByVersion.get(versionId);
    if (pageId && !wikiPageIds.includes(pageId)) wikiPageIds.push(pageId);
  }
  const question = truncateText(String(raw.question ?? ''), 240);
  const skipNote = typeof raw.skipReason === 'string' && raw.skipReason ? `（${raw.skipReason}）` : '';
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `query:${artifactId}`,
    eventType: 'query',
    time: String(raw.createdAt ?? ''),
    objectType: 'query_artifact',
    objectId: artifactId,
    title: `问答写回 · ${String(raw.writeBackDecision ?? '')}`,
    summary: `${question}${skipNote}`,
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
    actor: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    versionRefs: Object.freeze({
      ...versionRefs,
      changeSetId: typeof raw.changeSetId === 'string' ? raw.changeSetId : null,
      receiptId: typeof raw.receiptId === 'string' ? raw.receiptId : null,
      noteVersionIds: Object.freeze(noteVersionIds),
      wikiPageVersionIds: Object.freeze(wikiPageVersionIds)
    }),
    refs: Object.freeze({ ...emptyRefs(), noteIds: Object.freeze(noteIds), wikiPageIds: Object.freeze(wikiPageIds) }),
    locator: Object.freeze({ kind: 'query_artifact', id: artifactId })
  });
}

function buildSourceEntry(raw: Readonly<Record<string, unknown>>): KnowledgeLogEntry {
  const revisionId = String(raw.id ?? '');
  const versionRefs = emptyVersionRefs();
  return Object.freeze({
    id: `source:${revisionId}`,
    eventType: 'source',
    time: String(raw.createdAt ?? ''),
    objectType: 'source_revision',
    objectId: revisionId,
    title: `来源摄取 · ${truncateText(String(raw.url ?? raw.sourceId ?? ''), 80)}`,
    summary: `${String(raw.status ?? '')}${raw.contentType ? ` · ${String(raw.contentType)}` : ''}${raw.errorMessage ? ` · ${String(raw.errorMessage)}` : ''}`,
    scope: null,
    workspaceId: null,
    actor: null,
    versionRefs: Object.freeze({
      ...versionRefs,
      sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : null,
      sourceRevisionId: revisionId,
      previousSourceRevisionId: typeof raw.previousRevisionId === 'string' ? raw.previousRevisionId : null
    }),
    refs: Object.freeze({
      ...emptyRefs(),
      sourceIds: Object.freeze(typeof raw.sourceId === 'string' && raw.sourceId ? [raw.sourceId] : [])
    }),
    locator: Object.freeze({ kind: 'source_revision', id: revisionId })
  });
}

function buildEntry(row: LogRow, changeSet: ChangeSetEnrichment, compile: CompileEnrichment, query: QueryEnrichment): KnowledgeLogEntry {
  switch (row.eventType) {
    case 'change_set': return buildChangeSetEntry(row.raw, changeSet);
    case 'receipt': return buildReceiptEntry(row.raw);
    case 'compile': return buildCompileEntry(row.raw, compile);
    case 'lint_detected': return buildLintDetectedEntry(row.raw);
    case 'lint_resolved': return buildLintResolvedEntry(row.raw);
    case 'maintenance_started': return buildMaintenanceStartedEntry(row.raw as unknown as KnowledgeMaintenanceRun);
    case 'maintenance_completed': return buildMaintenanceCompletedEntry(row.raw as unknown as KnowledgeMaintenanceRun);
    case 'query': return buildQueryEntry(row.raw, query);
    case 'source': return buildSourceEntry(row.raw);
  }
}

// ============================================================
// 对外读 API
// ============================================================

/**
 * 统一时间日志分页读取（keyset 稳定分页）。
 * - 默认返回最新一页（time DESC, id DESC）；before 游标取更旧页；after 游标取更新页；
 * - 每页至多 limit（默认 50，最大 100）；total = 过滤口径全量计数（不含游标）；
 * - 历史锚点来自不可变时间列，重算结果一致（可重建、幂等）。
 */
export function listKnowledgeLogEntries(
  database: DatabaseSync,
  rawInput: KnowledgeLogReadFilter = {}
): KnowledgeLogPage {
  const filter = normalizeFilter(rawInput);
  const rowsByKind = fetchRows(database, filter);
  const streams = activeEventTypes(filter)
    .map((eventType) => rowsByKind.get(eventType) ?? [])
    .filter((stream) => stream.length > 0);

  let merged: LogRow[];
  let hasMore = false;
  if (filter.dir === 'newer') {
    merged = mergeAsc(streams);
    hasMore = merged.length > filter.limit;
    merged = merged.slice(0, filter.limit);
    merged.reverse();
  } else {
    merged = mergeDesc(streams);
    hasMore = merged.length > filter.limit;
    merged = merged.slice(0, filter.limit);
  }

  const changeSetRows = merged.filter((row) => row.eventType === 'change_set');
  const compileRows = merged.filter((row) => row.eventType === 'compile');
  const queryRows = merged.filter((row) => row.eventType === 'query');
  const changeSetEnrichment = enrichChangeSets(database, changeSetRows);
  const compileEnrichment = enrichCompile(database, compileRows);
  const queryEnrichment = enrichQuery(database, queryRows);

  const items = merged.map((row) => buildEntry(row, changeSetEnrichment, compileEnrichment, queryEnrichment));

  const counts = countRows(database, filter);
  const total = activeEventTypes(filter).reduce((sum, eventType) => sum + (counts.get(eventType) ?? 0), 0);

  const before = items.length > 0 ? encodeKnowledgeLogCursor(items[items.length - 1].time, items[items.length - 1].id) : null;
  const after = items.length > 0 ? encodeKnowledgeLogCursor(items[0].time, items[0].id) : null;

  const hasMoreBefore = filter.dir === 'newer' ? true : hasMore;
  const hasMoreAfter = filter.dir === 'newer' ? hasMore : false;

  return Object.freeze({
    items: Object.freeze(items),
    total,
    limit: filter.limit,
    before,
    after,
    hasMore,
    hasMoreBefore,
    hasMoreAfter
  });
}

/**
 * 单条目读取（可导航定位/详情入口）。id 形如 `${eventType}:${objectId}`（即列表条目 id）。
 * 不存在或事件类与对象不匹配返回 null。
 */
export function getKnowledgeLogEntry(database: DatabaseSync, id: string): KnowledgeLogEntry | null {
  if (typeof id !== 'string' || !id) return null;
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const eventType = id.slice(0, colon) as KnowledgeLogEventType;
  const objectId = id.slice(colon + 1);
  if (!ALL_EVENT_TYPES.includes(eventType) || !objectId) return null;

  const filter = normalizeFilter({ eventType, objectId, limit: 1 });
  const rowsByKind = fetchRows(database, filter);
  const rows = rowsByKind.get(eventType) ?? [];
  if (rows.length === 0) return null;
  const row = rows[0];
  const changeSetEnrichment = enrichChangeSets(database, row.eventType === 'change_set' ? [row] : []);
  const compileEnrichment = enrichCompile(database, row.eventType === 'compile' ? [row] : []);
  const queryEnrichment = enrichQuery(database, row.eventType === 'query' ? [row] : []);
  return buildEntry(row, changeSetEnrichment, compileEnrichment, queryEnrichment);
}
