// WMB-5238：统一全文搜索 + 索引摘要 + 有界 hot cache 只读 store（本 worker：ImplementWikiUnifiedSearch）。
// Design: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md + WMB-5238 施工许可
//  （M-5240：SQLite 内建 Wiki 索引 / 全局时间日志 / 统一全文搜索；index/log/hot-cache 等价读模型，不制造 Markdown 真源）。
// 定位：只读消费迁移 63 预压平索引表 knowledge_index_entries（每对象一行，searchable_text 有界），
//  绝不打源表（source_body_cache / knowledge_wiki_page_versions.body_json 可能很大）；索引即读模型，非第二真源。
// 约束：
// - 搜索 LIKE 只打 knowledge_index_entries，用户查询中的 LIKE 通配符转义为字面量（严格输入）；
// - 排序完全确定：titleHit DESC, updated_at DESC, object_type ASC, object_id ASC；
// - 游标 = base64url(JSON {h,u,t,i})，非法/损坏/越界 → INVALID_CURSOR fail-closed；
// - 空查询（trim 后为空）→ 空结果 total 0（契约语义，非全量分页）；
// - limit 有界 1..100 默认 20；objectTypes/topicId/scope 非法 → INVALID_INPUT；
// - hot cache 内存有界（单库 ≤500 条、跨库 ≤8 指纹），按指纹惰性重建，可丢弃、非真源、零 DB 写面；
// - workspace 隔离为结构性（data-root 独立 DB 文件）；本模块只读传入数据库。

import type { DatabaseSync } from 'node:sqlite';
import {
  WIKI_SEARCH_OBJECT_TYPES,
  type WikiHotCacheStatus,
  type WikiIndexSummary,
  type WikiSearchFilter,
  type WikiSearchObjectType,
  type WikiSearchPage,
  type WikiSearchResult,
  type WikiSearchVersionRef
} from '../shared/knowledge-search.ts';
import { resolveKnowledgeDeepLink } from './knowledge-topic-library.ts';
import type { KnowledgeDeepLinkPayload } from '../shared/knowledge-topic-library.ts';

const INDEX_TABLE = 'knowledge_index_entries';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const HOT_CACHE_MAX_ENTRIES = 500;
const HOT_CACHE_MAX_DATABASES = 8;
const LANE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const OBJECT_TYPE_SET: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(WIKI_SEARCH_OBJECT_TYPES.map((type) => [type, true])) as Record<string, true>
);

/** 深链对象类型映射：索引对象类型 → resolveKnowledgeDeepLink 认识的对象类型（同 ID 空间）。 */
const DEEP_LINK_TYPE: Readonly<Record<WikiSearchObjectType, string>> = Object.freeze({
  wiki_page: 'wiki_page',
  knowledge_note: 'knowledge_note',
  entity: 'knowledge_entity',
  topic: 'topic',
  source: 'source',
  fixed_version_reference: 'fixed_version_reference'
});

export class KnowledgeSearchError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'KnowledgeSearchError';
    this.code = code;
    this.details = details;
  }
}

function fail(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new KnowledgeSearchError(code, message, details);
}

// ============================================================
// 输入校验（fail-closed）
// ============================================================

function requireIndexTable(database: DatabaseSync): void {
  const row = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(INDEX_TABLE) as
    | { 1?: number } | undefined;
  if (!row) {
    fail('INDEX_TABLE_NOT_FOUND', `知识索引表 ${INDEX_TABLE} 不存在（migration 63 未落地）。`);
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_INPUT', 'limit 必须为有限数值。');
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function parseObjectTypes(value: unknown): WikiSearchObjectType[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_INPUT', 'objectTypes 必须为非空数组或省略。');
  const seen: WikiSearchObjectType[] = [];
  const seenSet = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !OBJECT_TYPE_SET[item]) {
      fail('INVALID_INPUT', `未知对象类型：${String(item)}`, { objectTypes: value });
    }
    if (!seenSet.has(item)) {
      seenSet.add(item);
      seen.push(item as WikiSearchObjectType);
    }
  }
  return seen;
}

function parseScope(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('INVALID_INPUT', 'scope 必须为字符串。');
  if (value === 'global') return value;
  if (value.startsWith('lane:')) {
    const key = value.slice('lane:'.length);
    if (LANE_KEY_PATTERN.test(key)) return value;
  }
  fail('INVALID_INPUT', `非法 scope：${value}（必须为 global 或 lane:<key>）。`);
}

function parseTopicId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', 'topicId 必须为非空字符串。');
  return value.trim();
}

function parseQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('INVALID_INPUT', 'query 必须为字符串。');
  return value.trim();
}

/** LIKE 通配符转义：用户输入按字面量匹配（\ % _ 前加反斜杠，SQL 侧 ESCAPE '\'）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ============================================================
// 游标（base64url(JSON {h,u,t,i})；稳定排序键 tuple）
// ============================================================

type CursorParts = Readonly<{
  h: number;
  u: string;
  t: WikiSearchObjectType;
  i: string;
}>;

function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

function decodeCursor(value: string): CursorParts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    fail('INVALID_CURSOR', '游标无法解析。');
  }
  if (typeof parsed !== 'object' || parsed === null) fail('INVALID_CURSOR', '游标结构非法。');
  const record = parsed as Record<string, unknown>;
  const h = record.h;
  const u = record.u;
  const t = record.t;
  const i = record.i;
  if (h !== 0 && h !== 1) fail('INVALID_CURSOR', '游标 titleHit 字段非法。');
  if (typeof u !== 'string' || !u) fail('INVALID_CURSOR', '游标 updatedAt 字段非法。');
  if (typeof t !== 'string' || !OBJECT_TYPE_SET[t]) fail('INVALID_CURSOR', '游标 objectType 字段非法。');
  if (typeof i !== 'string' || !i) fail('INVALID_CURSOR', '游标 objectId 字段非法。');
  return { h, u, t: t as WikiSearchObjectType, i };
}

// ============================================================
// 命中片段（命中词前后 ±60 字符；标题命中优先展示标题）
// ============================================================

const SNIPPET_CONTEXT = 60;

function buildSnippet(query: string, title: string, summary: string, searchableText: string): string {
  const q = query.toLowerCase();
  if (!q) {
    const head = (title || summary || searchableText).trim();
    return head.length <= SNIPPET_CONTEXT * 2 ? head : `${head.slice(0, SNIPPET_CONTEXT * 2)}…`;
  }
  const candidates = [title, summary, searchableText];
  for (const text of candidates) {
    if (!text) continue;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const start = Math.max(0, at - SNIPPET_CONTEXT);
    const end = Math.min(text.length, at + q.length + SNIPPET_CONTEXT);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return `${prefix}${text.slice(start, end)}${suffix}`.trim() || text.slice(0, SNIPPET_CONTEXT * 2);
  }
  // 无直接命中（理论上不会发生：WHERE 已保证至少一列命中）→ 摘要兜底
  const fallback = (summary || searchableText || title).trim();
  return fallback.length <= SNIPPET_CONTEXT * 2 ? fallback : `${fallback.slice(0, SNIPPET_CONTEXT * 2)}…`;
}

function buildNavigation(database: DatabaseSync, row: {
  objectType: WikiSearchObjectType;
  objectId: string;
  navObjectType: string | null;
  navObjectId: string | null;
}): KnowledgeDeepLinkPayload {
  const deepLinkType = row.navObjectType ?? DEEP_LINK_TYPE[row.objectType];
  const deepLinkId = row.navObjectId ?? row.objectId;
  return resolveKnowledgeDeepLink(database, { objectType: deepLinkType, objectId: deepLinkId });
}

// ============================================================
// 统一全文搜索
// ============================================================

type IndexEntryRow = Readonly<{
  objectType: WikiSearchObjectType;
  objectId: string;
  versionRef: WikiSearchVersionRef;
  title: string;
  summary: string;
  searchableText: string;
  updatedAt: string;
  topicIdsJson: string;
  scope: string;
  navObjectType: string | null;
  navObjectId: string | null;
  titleHit: number;
}>;

export function searchWikiIndex(database: DatabaseSync, rawInput: unknown): WikiSearchPage {
  requireIndexTable(database);
  if (typeof rawInput !== 'object' || rawInput === null) fail('INVALID_INPUT', '搜索输入必须为对象。');
  const input = rawInput as WikiSearchFilter;

  const query = parseQuery(input.query);
  const limit = parseLimit(input.limit);
  const objectTypes = parseObjectTypes(input.objectTypes);
  const scope = parseScope(input.scope);
  const topicId = parseTopicId(input.topicId);
  const cursor = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;

  // 空查询语义：固定返回空结果（total 0），不做全量分页（契约写明）。
  if (!query) {
    return Object.freeze({ items: [], total: 0, limit, offset: 0, hasMore: false, cursor: null });
  }

  const pattern = `%${escapeLike(query)}%`;
  const where: string[] = [];
  const args: Array<string | number> = [];

  where.push(`(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR searchable_text LIKE ? ESCAPE '\\')`);
  args.push(pattern, pattern, pattern);

  if (objectTypes.length) {
    where.push(`object_type IN (${objectTypes.map(() => '?').join(',')})`);
    args.push(...objectTypes);
  }
  if (scope) {
    where.push('scope = ?');
    args.push(scope);
  }
  if (topicId) {
    where.push(`EXISTS (SELECT 1 FROM json_each(knowledge_index_entries.topic_ids_json) AS jt WHERE jt.value = ?)`);
    args.push(topicId);
  }

  const whereClause = where.join(' AND ');

  // total = 全部匹配行（同一次快照；不依赖游标）。
  const total = Number((database.prepare(
    `SELECT count(*) AS count FROM knowledge_index_entries WHERE ${whereClause}`
  ).get(...args) as { count: number }).count);

  // 键集分页谓词（严格大于游标键的行；与 ORDER BY 同向同序）。
  // titleHit 表达式在分页谓词中绑定 4 个 pattern 参数，顺序与字符串占位符一致。
  const titleHitExpr = `(CASE WHEN title LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`;
  const keysetClause = cursor
    ? ` AND (
        ${titleHitExpr} < ? OR
        (${titleHitExpr} = ? AND updated_at < ?) OR
        (${titleHitExpr} = ? AND updated_at = ? AND object_type > ?) OR
        (${titleHitExpr} = ? AND updated_at = ? AND object_type = ? AND object_id > ?)
      )`
    : '';
  const keysetArgs: Array<string | number> = cursor
    ? [
        pattern, cursor.h,
        pattern, cursor.h, cursor.u,
        pattern, cursor.h, cursor.u, cursor.t,
        pattern, cursor.h, cursor.u, cursor.t, cursor.i
      ]
    : [];

  // offset = 严格位于游标之前的行数（同一次快照语义）。
  let offset = 0;
  if (cursor) {
    const offsetRow = database.prepare(
      `SELECT count(*) AS count FROM knowledge_index_entries WHERE ${whereClause}${keysetClause}`
    ).get(...args, ...keysetArgs) as { count: number };
    offset = Number(offsetRow.count);
  }

  // 注意绑定顺序：SELECT 的 titleHitExpr '?' 在 SQL 文本中先于 WHERE 占位符。
  const rows = database.prepare(`
    SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef,
           title, summary, searchable_text AS searchableText, updated_at AS updatedAt,
           topic_ids_json AS topicIdsJson, scope, nav_object_type AS navObjectType,
           nav_object_id AS navObjectId,
           ${titleHitExpr} AS titleHit
    FROM knowledge_index_entries
    WHERE ${whereClause}${keysetClause}
    ORDER BY titleHit DESC, updated_at DESC, object_type ASC, object_id ASC
    LIMIT ?
  `).all(pattern, ...args, ...keysetArgs, limit) as unknown as IndexEntryRow[];

  const items = rows.map((row) => {
    const result: WikiSearchResult = Object.freeze({
      objectType: row.objectType,
      objectId: row.objectId,
      versionRef: row.versionRef,
      title: row.title,
      snippet: buildSnippet(query, row.title, row.summary, row.searchableText),
      updatedAt: row.updatedAt,
      navigation: buildNavigation(database, row)
    });
    return result;
  });

  const hasMore = offset + items.length < total;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ h: Number(last.titleHit), u: last.updatedAt, t: last.objectType, i: last.objectId })
    : null;

  return Object.freeze({ items, total, limit, offset, hasMore, cursor: nextCursor });
}

// ============================================================
// 索引摘要 + 有界 hot cache（内存，按 DB 指纹惰性刷新；非真源、可丢弃重建、零 DB 写面）
// ============================================================

type HotCacheValue = Readonly<{
  fingerprint: string;
  rebuiltAt: string;
  summary: WikiIndexSummary;
  recent: readonly WikiSearchResult[];
}>;

const hotCaches = new Map<string, HotCacheValue>();

function indexFingerprint(database: DatabaseSync): string {
  const row = database.prepare(
    `SELECT count(*) AS count, coalesce(max(updated_at), '') AS latest FROM knowledge_index_entries`
  ).get() as { count: number; latest: string };
  return `${row.count}:${row.latest}`;
}

function loadRecentRows(database: DatabaseSync, limit: number): IndexEntryRow[] {
  return database.prepare(`
    SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef,
           title, summary, searchable_text AS searchableText, updated_at AS updatedAt,
           topic_ids_json AS topicIdsJson, scope, nav_object_type AS navObjectType,
           nav_object_id AS navObjectId,
           (CASE WHEN title LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS titleHit
    FROM knowledge_index_entries
    ORDER BY updated_at DESC, object_type ASC, object_id ASC
    LIMIT ?
  `).all('%%', limit) as unknown as IndexEntryRow[];
}

function buildHotCacheValue(database: DatabaseSync, nowIso: string): HotCacheValue {
  const counts: Record<WikiSearchObjectType, number> = {
    wiki_page: 0, knowledge_note: 0, entity: 0, topic: 0, source: 0, fixed_version_reference: 0
  };
  const countRows = database.prepare(
    `SELECT object_type AS objectType, count(*) AS count FROM knowledge_index_entries GROUP BY object_type`
  ).all() as Array<{ objectType: WikiSearchObjectType; count: number }>;
  for (const row of countRows) {
    if (OBJECT_TYPE_SET[row.objectType]) counts[row.objectType] = Number(row.count);
  }
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_index_entries`).get() as { count: number }).count);
  const latestRow = database.prepare(`SELECT max(updated_at) AS latest FROM knowledge_index_entries`).get() as { latest: string | null };
  const recent = loadRecentRows(database, HOT_CACHE_MAX_ENTRIES).map((row) => Object.freeze({
    objectType: row.objectType,
    objectId: row.objectId,
    versionRef: row.versionRef,
    title: row.title,
    snippet: buildSnippet('', row.title, row.summary, row.searchableText),
    updatedAt: row.updatedAt,
    navigation: buildNavigation(database, row)
  }));
  return Object.freeze({
    fingerprint: indexFingerprint(database),
    rebuiltAt: nowIso,
    summary: Object.freeze({
      counts: Object.freeze(counts),
      total,
      updatedAt: latestRow.latest ?? null,
      rebuiltAt: nowIso
    }),
    recent
  });
}

function storeHotCache(database: DatabaseSync, value: HotCacheValue): void {
  if (hotCaches.size >= HOT_CACHE_MAX_DATABASES) {
    const oldest = hotCaches.keys().next().value as string | undefined;
    if (oldest !== undefined) hotCaches.delete(oldest);
  }
  hotCaches.set(value.fingerprint, value);
}

function toStatus(value: HotCacheValue): WikiHotCacheStatus {
  return Object.freeze({
    cached: true,
    rebuiltAt: value.rebuiltAt,
    entryCount: value.recent.length,
    maxEntries: HOT_CACHE_MAX_ENTRIES,
    summary: value.summary
  });
}

/** 强制重建当前库的 hot cache（可丢弃、非真源；返回重建后的状态）。 */
export function rebuildWikiHotCache(database: DatabaseSync): WikiHotCacheStatus {
  requireIndexTable(database);
  const value = buildHotCacheValue(database, new Date().toISOString());
  storeHotCache(database, value);
  return toStatus(value);
}

/** 读取当前库 hot cache；指纹变化（任何索引写入/删除）→ 惰性重建。 */
export function getWikiHotCache(database: DatabaseSync): WikiHotCacheStatus {
  requireIndexTable(database);
  const fingerprint = indexFingerprint(database);
  const existing = hotCaches.get(fingerprint);
  if (existing) return toStatus(existing);
  const value = buildHotCacheValue(database, new Date().toISOString());
  storeHotCache(database, value);
  return toStatus(value);
}

/** 索引摘要：直接读索引表（权威），附 hot cache 最近重建时间（未重建为 null）。 */
export function getWikiIndexSummary(database: DatabaseSync): WikiIndexSummary {
  requireIndexTable(database);
  const fingerprint = indexFingerprint(database);
  const cached = hotCaches.get(fingerprint);
  if (cached) return cached.summary;
  const value = buildHotCacheValue(database, new Date().toISOString());
  storeHotCache(database, value);
  return value.summary;
}
