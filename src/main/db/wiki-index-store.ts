import type { DatabaseSync } from 'node:sqlite';

/**
 * WMB-5238：SQLite 内建 Wiki 统一搜索索引 + 持久化 hot cache 存储核心（本 worker：ImplementWikiIndexStore）。
 *
 * 读模型真源：知识业务表（knowledge_wiki_pages/versions、knowledge_notes/versions、
 * knowledge_entities、topics、source_items、source_body_revisions、source_body_cache、
 * topic_source_links）。本模块只写派生表 knowledge_index_entries / knowledge_hot_cache，
 * 绝不写/改/删任何业务真源表 —— 索引可从业务表整表重建（rebuildWikiIndex），非第二真源。
 *
 * 事务约定（与 applyKnowledgeChangeSet 一致）：
 * - transaction=true（默认）：函数内部 BEGIN IMMEDIATE / COMMIT / ROLLBACK，独立原子；
 * - transaction=false：调用方持有事务（dispatcher 已 BEGIN，或 WireWikiIndexTriggers 用
 *   SAVEPOINT 包裹），本模块只执行语句不管理边界。background/backfill 连接无 write guard，
 *   运行时连接必须在 dispatcher 授权窗口内调用（write guard 全表 TEMP trigger）。
 *
 * 历史固定引用不抹除：upsert 只写当前投影行 + 追加固定版本引用行（fixed_version_reference），
 * 绝不 DELETE 业务版本表行或既有 fvr 行；rebuild 从业务表全量重建（含全部不可变版本行）。
 *
 * searchable_text 有界：MAX_SEARCHABLE_TEXT_CHARS（8000）截断，保证 LIKE 打小表。
 */

export type WikiIndexObjectType = 'wiki_page' | 'knowledge_note' | 'entity' | 'topic' | 'source' | 'fixed_version_reference';

export const WIKI_INDEX_OBJECT_TYPES: readonly WikiIndexObjectType[] = Object.freeze([
  'wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference'
]);

export const MAX_SEARCHABLE_TEXT_CHARS = 8000;

export type WikiIndexEntryInput = Readonly<{
  objectType: WikiIndexObjectType;
  objectId: string;
  /** 固定版本/修订锚（与 rebuild 逐字节一致：版本 id / 'rev:{revision}'）。 */
  versionRef: string;
  title: string;
  summary?: string;
  searchableText?: string;
  topicIds?: readonly string[];
  scope?: string;
  compileStatus?: string | null;
  updatedAt: string;
  navObjectType?: string | null;
  navObjectId?: string | null;
  /** 便捷导航字段：string（视为 navObjectId，navObjectType 回退 objectType）或
   *  resolveKnowledgeDeepLink 载荷 shape {objectType, objectId}（深链同源 ID 空间）。 */
  locator?: string | Readonly<Record<string, unknown>> | null;
}>;

export type WikiIndexEntryKey = Readonly<{ objectType: WikiIndexObjectType; objectId: string }>;

export type WikiIndexEntryRecord = Readonly<{
  objectType: WikiIndexObjectType;
  objectId: string;
  versionRef: string;
  title: string;
  summary: string;
  searchableText: string;
  topicIds: readonly string[];
  scope: string;
  compileStatus: string;
  updatedAt: string;
  navObjectType: string | null;
  navObjectId: string | null;
}>;

export type WikiIndexRebuildResult = Readonly<{
  total: number;
  byType: Readonly<Record<WikiIndexObjectType, number>>;
  rebuiltAt: string;
}>;

export type WikiIndexSummary = Readonly<{
  total: number;
  counts: Readonly<Record<WikiIndexObjectType, number>>;
  updatedAt: string | null;
  rebuiltAt: string;
}>;

export type WikiHotCacheRecord = Readonly<{ payloadJson: string; rebuiltAt: string }>;

function truncateText(value: string, max = MAX_SEARCHABLE_TEXT_CHARS): string {
  return value.length <= max ? value : value.slice(0, max);
}

function normalizeScope(scope: string | null | undefined): string {
  if (!scope) return 'global';
  return scope === 'global' || scope.startsWith('lane:') ? scope : 'global';
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

/**
 * 解析索引行的导航字段（resolveKnowledgeDeepLink 同源 ID 空间）。
 * 优先级：显式 navObjectType/navObjectId > locator（string=navObjectId；
 * 对象=深链载荷 shape {objectType, objectId}）> 对象自身类型/id（fvr 行回退父对象由调用方传入）。
 */
function resolveNav(
  entry: Pick<WikiIndexEntryInput, 'objectType' | 'objectId' | 'navObjectType' | 'navObjectId' | 'locator'>
): { navObjectType: string | null; navObjectId: string | null } {
  let navObjectType = entry.navObjectType ?? null;
  let navObjectId = entry.navObjectId ?? null;
  const locator = entry.locator;
  if (locator !== undefined && locator !== null) {
    if (typeof locator === 'string') {
      if (!navObjectId) navObjectId = locator;
    } else if (typeof locator === 'object') {
      const record = locator as Readonly<Record<string, unknown>>;
      if (!navObjectType && typeof record.objectType === 'string' && record.objectType) {
        navObjectType = record.objectType;
      }
      if (!navObjectId && typeof record.objectId === 'string' && record.objectId) {
        navObjectId = record.objectId;
      }
    }
  }
  if (!navObjectType) navObjectType = entry.objectType === 'fixed_version_reference' ? null : entry.objectType;
  if (!navObjectId) navObjectId = entry.objectId;
  return { navObjectType, navObjectId };
}

/** 递归收集 JSON 中的全部字符串叶值（预压平正文用；body_json 是结构化 JSON）。 */
function flattenJsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) flattenJsonStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && child !== undefined) flattenJsonStrings(child, out);
    }
  }
  return out;
}

function parseBodyJson(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    return flattenJsonStrings(JSON.parse(value)).join(' ');
  } catch {
    return '';
  }
}

function buildSearchableText(title: string, summary: string, body: string): string {
  return truncateText([title, summary, body].filter(Boolean).join(' '));
}

function requireIndexTable(database: DatabaseSync): void {
  const row = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'knowledge_index_entries'").get() as
    | { 1?: number } | undefined;
  if (!row) {
    throw new Error('WIKI_INDEX_TABLE_NOT_FOUND: knowledge_index_entries 不存在（migration 63 未落地）。');
  }
}

// ============================================================
// 原子 upsert / delete
// ============================================================

const UPSERT_SQL = `
  INSERT INTO knowledge_index_entries (
    object_type, object_id, version_ref, title, summary, searchable_text,
    topic_ids_json, scope, compile_status, updated_at, nav_object_type, nav_object_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(object_type, object_id) DO UPDATE SET
    version_ref = excluded.version_ref,
    title = excluded.title,
    summary = excluded.summary,
    searchable_text = excluded.searchable_text,
    topic_ids_json = excluded.topic_ids_json,
    scope = excluded.scope,
    compile_status = excluded.compile_status,
    updated_at = excluded.updated_at,
    nav_object_type = excluded.nav_object_type,
    nav_object_id = excluded.nav_object_id
`;

/**
 * 原子 upsert 一或多条索引行（transaction=true 时整体原子）。
 * 幂等：同 (objectType, objectId) 重复调用结果一致；仅替换当前投影行内容，不删除任何历史行。
 */
export function upsertIndexEntries(
  database: DatabaseSync,
  entries: readonly WikiIndexEntryInput[],
  transaction = true
): number {
  requireIndexTable(database);
  if (entries.length === 0) return 0;
  const statement = database.prepare(UPSERT_SQL);
  let count = 0;
  const run = (): number => {
    for (const entry of entries) {
      const { navObjectType, navObjectId } = resolveNav(entry);
      statement.run(
        entry.objectType,
        entry.objectId,
        entry.versionRef,
        truncateText(entry.title ?? ''),
        truncateText(entry.summary ?? '', 2000),
        truncateText(entry.searchableText ?? ''),
        JSON.stringify(entry.topicIds ?? []),
        normalizeScope(entry.scope),
        entry.compileStatus ?? 'current',
        entry.updatedAt,
        navObjectType,
        navObjectId
      );
      count += 1;
    }
    return count;
  };
  if (!transaction) return run();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 原子删除指定 (objectType, objectId) 索引行。业务对象生命周期收口（archive/supersede 不应
 * 触发删除——历史行保留；仅对象真删除/回滚投影时使用）。
 */
export function removeIndexEntries(
  database: DatabaseSync,
  keys: readonly WikiIndexEntryKey[],
  transaction = true
): void {
  requireIndexTable(database);
  if (keys.length === 0) return;
  const statement = database.prepare('DELETE FROM knowledge_index_entries WHERE object_type = ? AND object_id = ?');
  const run = (): void => {
    for (const key of keys) {
      statement.run(key.objectType, key.objectId);
    }
  };
  if (!transaction) {
    run();
    return;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    run();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// ============================================================
// 整表重建（从业务表派生；唯一真源仍是业务表）
// ============================================================

/**
 * 从业务表整表重建知识索引（DELETE + INSERT 同一事务，原子；fresh DB 幂等零写）。
 * 覆盖：
 * - wiki_page 当前行（current_version_id → 版本 title/body_json）+ 全部 wiki_page_versions 的 fvr 行；
 * - knowledge_note 当前行（current_version_id → 版本 title/statement/body）+ 全部 note_versions fvr 行；
 * - entity 行（version_ref = rev:{revision}；canonical_name/aliases 入 searchable）；
 * - topic 行（version_ref = rev:{revision}；title/summary/canonical_key）；
 * - source 行（version_ref = 最新 source_body_revisions id 或 rev:{revision}；
 *   title/summary/keywords + source_body_cache.extracted_text）+ 全部 source_body_revisions fvr 行。
 * fvr 行的 nav 指向父对象（wiki_page/note/source），保证深链可导航。
 */
export function rebuildWikiIndex(database: DatabaseSync, transaction = true): WikiIndexRebuildResult {
  requireIndexTable(database);
  const rebuiltAt = new Date().toISOString();
  const run = (): WikiIndexRebuildResult => {
    database.exec('DELETE FROM knowledge_index_entries');
    const byType: Record<WikiIndexObjectType, number> = {
      wiki_page: 0, knowledge_note: 0, entity: 0, topic: 0, source: 0, fixed_version_reference: 0
    };
    const upsert = database.prepare(UPSERT_SQL);
    const put = (input: WikiIndexEntryInput): void => {
      const { navObjectType, navObjectId } = resolveNav(input);
      upsert.run(
        input.objectType,
        input.objectId,
        input.versionRef,
        truncateText(input.title ?? ''),
        truncateText(input.summary ?? '', 2000),
        truncateText(input.searchableText ?? ''),
        JSON.stringify(input.topicIds ?? []),
        normalizeScope(input.scope),
        input.compileStatus ?? 'current',
        input.updatedAt,
        navObjectType,
        navObjectId
      );
      byType[input.objectType] += 1;
    };

    // ---- wiki pages：当前投影 + 全部版本 fvr ----
    const wikiPages = database.prepare(`
      SELECT p.id AS pageId, p.scope, p.compile_status AS compileStatus, p.subject_type AS subjectType,
             p.subject_id AS subjectId, p.updated_at AS updatedAt, p.revision AS revision,
             p.current_version_id AS currentVersionId
      FROM knowledge_wiki_pages p
      WHERE p.lifecycle = 'active'
    `).all() as Array<{
      pageId: string; scope: string; compileStatus: string; subjectType: string | null;
      subjectId: string | null; updatedAt: string; revision: number; currentVersionId: string | null;
    }>;
    const wikiVersionByPage = new Map<string, Array<{ id: string; title: string; bodyJson: string; createdAt: string }>>();
    try {
      const versionRows = database.prepare(`
        SELECT page_id AS pageId, id, title, body_json AS bodyJson, created_at AS createdAt
        FROM knowledge_wiki_page_versions
      `).all() as Array<{ pageId: string; id: string; title: string; bodyJson: string; createdAt: string }>;
      for (const version of versionRows) {
        const list = wikiVersionByPage.get(version.pageId) ?? [];
        list.push(version);
        wikiVersionByPage.set(version.pageId, list);
      }
    } catch {
      // 精简 fixture 缺 v56 表 → 跳过 wiki 索引（同 store 既有 ENDPOINT_TABLES 宽松模式）
    }
    for (const page of wikiPages) {
      const versions = wikiVersionByPage.get(page.pageId) ?? [];
      const current = versions.find((version) => version.id === page.currentVersionId) ?? versions[0];
      const bodyText = current ? parseBodyJson(current.bodyJson) : '';
      const topicIds = page.subjectType === 'topic' && page.subjectId ? [page.subjectId] : [];
      put({
        objectType: 'wiki_page',
        objectId: page.pageId,
        versionRef: current?.id ?? `rev:${page.revision}`,
        title: current?.title ?? page.pageId,
        summary: '',
        searchableText: buildSearchableText(current?.title ?? '', '', bodyText),
        topicIds,
        scope: page.scope,
        compileStatus: page.compileStatus,
        // 与增量投影 buildWikiPageEntry 同源：topic/entity 主题页导航指向业务主体，否则回退页面自身。
        updatedAt: current?.createdAt ?? page.updatedAt,
        navObjectType: page.subjectType === 'topic' ? 'topic' : page.subjectType === 'entity' ? 'knowledge_entity' : page.subjectType ?? null,
        navObjectId: page.subjectId
      });
      for (const version of versions) {
        put({
          objectType: 'fixed_version_reference',
          objectId: version.id,
          versionRef: version.id,
          title: version.title,
          summary: '',
          searchableText: buildSearchableText(version.title, '', parseBodyJson(version.bodyJson)),
          topicIds,
          scope: page.scope,
          compileStatus: page.compileStatus,
          updatedAt: version.createdAt,
          navObjectType: 'wiki_page',
          navObjectId: page.pageId
        });
      }
    }

    // ---- knowledge notes：当前投影 + 全部版本 fvr ----
    const notes = database.prepare(`
      SELECT n.id AS noteId, n.scope, n.updated_at AS updatedAt, n.revision AS revision,
             n.current_version_id AS currentVersionId
      FROM knowledge_notes n
      WHERE n.lifecycle = 'active'
    `).all() as Array<{ noteId: string; scope: string; updatedAt: string; revision: number; currentVersionId: string | null }>;
    const noteVersionByNote = new Map<string, Array<{
      id: string; title: string; statement: string; body: string; adoptedTopicIdsJson: string; createdAt: string;
    }>>();
    try {
      const versionRows = database.prepare(`
        SELECT note_id AS noteId, id, title, statement, body,
               adopted_topic_ids_json AS adoptedTopicIdsJson, created_at AS createdAt
        FROM knowledge_note_versions
      `).all() as Array<{
        noteId: string; id: string; title: string; statement: string; body: string;
        adoptedTopicIdsJson: string; createdAt: string;
      }>;
      for (const version of versionRows) {
        const list = noteVersionByNote.get(version.noteId) ?? [];
        list.push(version);
        noteVersionByNote.set(version.noteId, list);
      }
    } catch {
      // 精简 fixture 缺 v56 表 → 跳过
    }
    for (const note of notes) {
      const versions = noteVersionByNote.get(note.noteId) ?? [];
      const current = versions.find((version) => version.id === note.currentVersionId) ?? versions[0];
      const topicIds = current ? parseStringArray(current.adoptedTopicIdsJson) : [];
      put({
        objectType: 'knowledge_note',
        objectId: note.noteId,
        versionRef: current?.id ?? `rev:${note.revision}`,
        title: current?.title ?? note.noteId,
        summary: current?.statement ?? '',
        searchableText: buildSearchableText(current?.title ?? '', current?.statement ?? '', current?.body ?? ''),
        topicIds,
        scope: note.scope,
        compileStatus: 'current',
        updatedAt: current?.createdAt ?? note.updatedAt,
        navObjectType: 'knowledge_note',
        navObjectId: note.noteId
      });
      for (const version of versions) {
        put({
          objectType: 'fixed_version_reference',
          objectId: version.id,
          versionRef: version.id,
          title: version.title,
          summary: version.statement,
          searchableText: buildSearchableText(version.title, version.statement, version.body),
          topicIds,
          scope: note.scope,
          compileStatus: 'current',
          updatedAt: version.createdAt,
          navObjectType: 'knowledge_note',
          navObjectId: note.noteId
        });
      }
    }

    // ---- entities ----
    try {
      const entityRows = database.prepare(`
        SELECT id, scope, canonical_name AS canonicalName, canonical_key AS canonicalKey,
               aliases_json AS aliasesJson, revision, updated_at AS updatedAt
        FROM knowledge_entities
        WHERE lifecycle = 'active'
      `).all() as Array<{
        id: string; scope: string; canonicalName: string; canonicalKey: string;
        aliasesJson: string; revision: number; updatedAt: string;
      }>;
      for (const entity of entityRows) {
        const aliases = parseStringArray(entity.aliasesJson);
        put({
          objectType: 'entity',
          objectId: entity.id,
          versionRef: `rev:${entity.revision}`,
          title: entity.canonicalName,
          summary: '',
          searchableText: buildSearchableText(entity.canonicalName, entity.canonicalKey, aliases.join(' ')),
          topicIds: [],
          scope: entity.scope,
          compileStatus: 'current',
          updatedAt: entity.updatedAt,
          navObjectType: 'knowledge_entity',
          navObjectId: entity.id
        });
      }
    } catch {
      // 精简 fixture 缺 v56 表 → 跳过
    }

    // ---- topics ----
    const topicRows = database.prepare(`
      SELECT id, title, summary, canonical_key AS canonicalKey, revision, updated_at AS updatedAt
      FROM topics WHERE status != 'archived'
    `).all() as Array<{
      id: string; title: string; summary: string | null; canonicalKey: string | null;
      revision: number; updatedAt: string;
    }>;
    for (const topic of topicRows) {
      put({
        objectType: 'topic',
        objectId: topic.id,
        versionRef: `rev:${topic.revision}`,
        title: topic.title,
        summary: topic.summary ?? '',
        searchableText: buildSearchableText(topic.title, topic.summary ?? '', topic.canonicalKey ?? ''),
        topicIds: [topic.id],
        scope: 'global',
        compileStatus: 'current',
        updatedAt: topic.updatedAt,
        navObjectType: 'topic',
        navObjectId: topic.id
      });
    }

    // ---- sources：当前投影（含最新正文）+ 全部正文版本 fvr ----
    const sourceTopicBySource = new Map<string, string[]>();
    try {
      const linkRows = database.prepare('SELECT source_id AS sourceId, topic_id AS topicId FROM topic_source_links').all() as Array<{
        sourceId: string; topicId: string;
      }>;
      for (const link of linkRows) {
        const list = sourceTopicBySource.get(link.sourceId) ?? [];
        if (!list.includes(link.topicId)) list.push(link.topicId);
        sourceTopicBySource.set(link.sourceId, list);
      }
    } catch {
      // 精简 fixture 缺 topic_source_links → 跳过
    }
    const bodyRevisionBySource = new Map<string, Array<{ id: string; createdAt: string; extractedText: string }>>();
    try {
      const revisionRows = database.prepare(`
        SELECT source_id AS sourceId, id, created_at AS createdAt, extracted_text AS extractedText
        FROM source_body_revisions WHERE status = 'ready'
      `).all() as Array<{ sourceId: string; id: string; createdAt: string; extractedText: string }>;
      for (const revision of revisionRows) {
        const list = bodyRevisionBySource.get(revision.sourceId) ?? [];
        list.push(revision);
        bodyRevisionBySource.set(revision.sourceId, list);
      }
    } catch {
      // 精简 fixture 缺 v61 表 → 跳过
    }
    const sourceRows = database.prepare(`
      SELECT id, title, summary, keywords_json AS keywordsJson, author, revision, updated_at AS updatedAt
      FROM source_items WHERE management_status != 'archived'
    `).all() as Array<{
      id: string; title: string; summary: string | null; keywordsJson: string; author: string | null;
      revision: number; updatedAt: string;
    }>;
    const bodyCacheBySource = new Map<string, string>();
    try {
      const cacheRows = database.prepare('SELECT source_id AS sourceId, extracted_text AS extractedText FROM source_body_cache').all() as Array<{
        sourceId: string; extractedText: string;
      }>;
      for (const cache of cacheRows) bodyCacheBySource.set(cache.sourceId, cache.extractedText);
    } catch {
      // 精简 fixture 缺 v31 表 → 正文为空
    }
    for (const source of sourceRows) {
      const revisions = bodyRevisionBySource.get(source.id) ?? [];
      revisions.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      const latestRevision = revisions[revisions.length - 1] ?? null;
      const keywords = parseStringArray(source.keywordsJson);
      const bodyText = bodyCacheBySource.get(source.id) ?? latestRevision?.extractedText ?? '';
      const topicIds = sourceTopicBySource.get(source.id) ?? [];
      put({
        objectType: 'source',
        objectId: source.id,
        versionRef: latestRevision?.id ?? `rev:${source.revision}`,
        title: source.title,
        summary: source.summary ?? '',
        searchableText: buildSearchableText(
          source.title,
          [source.summary ?? '', source.author ?? '', keywords.join(' ')].filter(Boolean).join(' '),
          bodyText
        ),
        topicIds,
        scope: 'global',
        compileStatus: 'current',
        updatedAt: source.updatedAt,
        navObjectType: 'source',
        navObjectId: source.id
      });
      for (const revision of revisions) {
        put({
          objectType: 'fixed_version_reference',
          objectId: revision.id,
          versionRef: revision.id,
          title: source.title,
          summary: '',
          searchableText: buildSearchableText(source.title, '', revision.extractedText),
          topicIds,
          scope: 'global',
          compileStatus: 'current',
          updatedAt: revision.createdAt,
          navObjectType: 'source',
          navObjectId: source.id
        });
      }
    }

    const total = Object.values(byType).reduce((sum, value) => sum + value, 0);
    return Object.freeze({ total, byType: Object.freeze({ ...byType }), rebuiltAt });
  };

  if (!transaction) return run();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// ============================================================
// 只读模型：列表 / 摘要
// ============================================================

const MAX_LIST_LIMIT = 100;

function parseListInput(rawInput: unknown): {
  objectType: WikiIndexObjectType | null;
  scope: string | null;
  query: string;
  limit: number;
  offset: number;
} {
  const value = (rawInput ?? {}) as Readonly<Record<string, unknown>>;
  const limit = Math.min(Math.max(typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.trunc(value.limit) : 50, 1), MAX_LIST_LIMIT);
  const offset = Math.max(typeof value.offset === 'number' && Number.isFinite(value.offset) ? Math.trunc(value.offset) : 0, 0);
  const objectType = typeof value.objectType === 'string' && (WIKI_INDEX_OBJECT_TYPES as readonly string[]).includes(value.objectType)
    ? value.objectType as WikiIndexObjectType
    : null;
  const scope = typeof value.scope === 'string' && value.scope.trim() ? value.scope.trim() : null;
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  return { objectType, scope, query, limit, offset };
}

function mapEntryRow(row: Record<string, unknown>): WikiIndexEntryRecord {
  return Object.freeze({
    objectType: String(row.objectType) as WikiIndexObjectType,
    objectId: String(row.objectId),
    versionRef: String(row.versionRef),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    searchableText: String(row.searchableText ?? ''),
    topicIds: parseStringArray(row.topicIdsJson),
    scope: String(row.scope ?? 'global'),
    compileStatus: String(row.compileStatus ?? 'current'),
    updatedAt: String(row.updatedAt),
    navObjectType: row.navObjectType === null || row.navObjectType === undefined ? null : String(row.navObjectType),
    navObjectId: row.navObjectId === null || row.navObjectId === undefined ? null : String(row.navObjectId)
  });
}

/** 有界列表（稳定排序：updated_at DESC, object_type ASC, object_id ASC；limit<=100）。 */
export function listIndexEntries(
  database: DatabaseSync,
  rawInput: unknown = {}
): { items: WikiIndexEntryRecord[]; total: number; limit: number; offset: number; hasMore: boolean } {
  requireIndexTable(database);
  const input = parseListInput(rawInput);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (input.objectType) {
    where.push('object_type = ?');
    args.push(input.objectType);
  }
  if (input.scope) {
    where.push('scope = ?');
    args.push(input.scope);
  }
  if (input.query) {
    const pattern = `%${input.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR searchable_text LIKE ? ESCAPE '\\')`);
    args.push(pattern, pattern, pattern);
  }
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((database.prepare(`SELECT count(*) AS count FROM knowledge_index_entries${whereClause}`).get(...args) as { count: number }).count);
  const rows = database.prepare(`
    SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef, title, summary,
           searchable_text AS searchableText, topic_ids_json AS topicIdsJson, scope, compile_status AS compileStatus,
           updated_at AS updatedAt, nav_object_type AS navObjectType, nav_object_id AS navObjectId
    FROM knowledge_index_entries${whereClause}
    ORDER BY updated_at DESC, object_type ASC, object_id ASC
    LIMIT ? OFFSET ?
  `).all(...args, input.limit, input.offset) as unknown as Record<string, unknown>[];
  return {
    items: rows.map(mapEntryRow),
    total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + rows.length < total
  };
}

/** 索引摘要：按类型计数 + 总量 + 最新 updated_at（hot cache/索引统计读面）。 */
export function getIndexSummary(database: DatabaseSync): WikiIndexSummary {
  requireIndexTable(database);
  const counts: Record<WikiIndexObjectType, number> = {
    wiki_page: 0, knowledge_note: 0, entity: 0, topic: 0, source: 0, fixed_version_reference: 0
  };
  const countRows = database.prepare('SELECT object_type AS objectType, count(*) AS count FROM knowledge_index_entries GROUP BY object_type').all() as Array<{
    objectType: WikiIndexObjectType; count: number;
  }>;
  for (const row of countRows) {
    if (WIKI_INDEX_OBJECT_TYPES.includes(row.objectType)) counts[row.objectType] = Number(row.count);
  }
  const totalRow = database.prepare('SELECT count(*) AS count FROM knowledge_index_entries').get() as { count: number };
  const latestRow = database.prepare('SELECT max(updated_at) AS latest FROM knowledge_index_entries').get() as { latest: string | null };
  return Object.freeze({
    total: Number(totalRow.count),
    counts: Object.freeze({ ...counts }),
    updatedAt: latestRow.latest ?? null,
    rebuiltAt: new Date().toISOString()
  });
}

// ============================================================
// 持久化 hot cache（单行 id=1；有界、可重建、非真源）
// ============================================================

/** 写入/刷新持久化 hot cache 单行（payload 由调用方决定 shape；有界单行）。 */
export function refreshWikiHotCache(database: DatabaseSync, payloadJson: string, transaction = true): void {
  requireIndexTable(database);
  const statement = database.prepare(`
    INSERT INTO knowledge_hot_cache (id, payload_json, rebuilt_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, rebuilt_at = excluded.rebuilt_at
  `);
  const rebuiltAt = new Date().toISOString();
  const run = (): void => {
    statement.run(payloadJson, rebuiltAt);
  };
  if (!transaction) {
    run();
    return;
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    run();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 从索引摘要 + 最近行重建持久化 hot cache 载荷（recent 有界 500 条）。
 * 返回写入的载荷（JSON 字符串）；调用方可直接 refreshWikiHotCache 复用。
 */
export function rebuildWikiHotCache(database: DatabaseSync, transaction = true): string {
  requireIndexTable(database);
  const summary = getIndexSummary(database);
  const recentRows = database.prepare(`
    SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef, title, summary,
           searchable_text AS searchableText, updated_at AS updatedAt, nav_object_type AS navObjectType,
           nav_object_id AS navObjectId
    FROM knowledge_index_entries
    ORDER BY updated_at DESC, object_type ASC, object_id ASC
    LIMIT 500
  `).all() as unknown as Record<string, unknown>[];
  const recent = recentRows.map((row) => ({
    objectType: String(row.objectType),
    objectId: String(row.objectId),
    versionRef: String(row.versionRef),
    title: String(row.title ?? ''),
    snippet: String(row.summary ?? '').slice(0, 120),
    updatedAt: String(row.updatedAt),
    navObjectType: row.navObjectType === null || row.navObjectType === undefined ? null : String(row.navObjectType),
    navObjectId: row.navObjectId === null || row.navObjectId === undefined ? null : String(row.navObjectId)
  }));
  const payload = JSON.stringify({ summary, recent, rebuiltAt: summary.rebuiltAt });
  refreshWikiHotCache(database, payload, transaction);
  return payload;
}

/** 读取持久化 hot cache 单行（无缓存返回 null）。 */
export function getWikiHotCache(database: DatabaseSync): WikiHotCacheRecord | null {
  requireIndexTable(database);
  const row = database.prepare('SELECT payload_json AS payloadJson, rebuilt_at AS rebuiltAt FROM knowledge_hot_cache WHERE id = 1').get() as
    | { payloadJson: string; rebuiltAt: string } | undefined;
  return row ? Object.freeze({ payloadJson: row.payloadJson, rebuiltAt: row.rebuiltAt }) : null;
}
