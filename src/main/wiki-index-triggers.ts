/**
 * WMB-5238：既有知识写路径 → SQLite 内建 Wiki 索引的增量投影接线。
 *
 * 覆盖（与 TASKS WMB-5238 / ReviewWikiSearchAcceptance 验收边界对齐）：
 * - Source 保存（upsertSource / updateKnowledgeSource / deleteKnowledgeSource）
 * - Source 正文固定版本（writeSourceBodyCache 追加 source_body_revisions）
 * - 知识编译 / Wiki 版本 / Query 写回 / Lint / 维护修复 / 初始化 / 反馈 —— 全部经统一写入口
 *   applyKnowledgeChangeSet（knowledge-flywheel.ts），由本模块注册的 post-commit hook 覆盖
 * - Topic 变化（upsertKnowledgeTopic / topic-maintenance executeFrozen）
 *
 * 架构决策（与 IndexStore/GlobalLog worker + ScoutWikiIndexContracts 审计对齐，锁定）：
 * - 显式 post-commit 投影，不用 SQL trigger：
 *   a) ChangeSet 统一写入口提交后同步触发（setKnowledgeChangeSetIndexTrigger /
 *      fireKnowledgeChangeSetIndexTrigger，knowledge-flywheel.ts 与局部 Lint hook 同构；
 *      与 Lint hook 的差异：对全部 ChangeSet 触发，含 triggerSource='lint' 的 Lint/维护写）；
 *   b) 非 ChangeSet 写路径在各自成功提交点显式调用本模块投影函数。
 * - 与正式写同连接、同事务（dispatcher 授权窗口内同步执行；独立连接 backfill 无 write guard，
 *   同连接投影同样成立）。失败/回滚 → 索引同回滚，不产生孤儿索引。
 * - 投影失败零阻断：SAVEPOINT 包裹 + 捕获 + console.error，绝不回滚已成功业务写；
 *   兜底 IndexStore.rebuildWikiIndex()（由 API 提供方实现）。
 * - 幂等：ChangeSet replay 零投影（fire hook 内短路）；索引按 (object_type, object_id) 单行
 *   upsert 天然幂等；source 正文同 hash 不产生新 revision → 不投影；同内容 source/topic
 *   重复保存不重复投影（实质字段比较）。
 * - 日志：全局时间日志是纯派生读模型（knowledge-global-log.ts：change_sets / receipts /
 *   wiki_page_versions / health_issues / query_artifacts / source_body_revisions / 维护 run KV），
 *   本模块没有任何日志写面（不制造第二套日志真源）；ChangeSet 编译、Source 正文摄取、
 *   维护开始/完成等事件由派生日志自动覆盖。
 *
 * 写授权：所有投影调用点都在 CommandDispatcher 授权窗口内（ChangeSet hook 在 dispatch
 * execute 内触发；upsertSource/writeSourceBodyCache/upsertKnowledgeTopic 均在 dispatcher
 * 命令内执行；独立连接 backfill 连接无 write guard）。write-guard 对迁移 63 新表同样生效，
 * 投影必须保持在授权深度内。
 * IndexStore API 契约：upsertIndexEntries / removeIndexEntry 必须是单语句或 SAVEPOINT 级原子
 * （禁止 BEGIN，投影可能运行在调用方既有事务内）。
 */
import { DatabaseSync } from 'node:sqlite';
import { getWikiPage, getWikiPageVersion, getKnowledgeNote, getKnowledgeNoteVersion, getKnowledgeEntity, setKnowledgeChangeSetIndexTrigger, type KnowledgeChangeSetIndexTriggerContext } from './knowledge-flywheel.ts';
import { resolveKnowledgeDeepLink } from './knowledge-topic-library.ts';

// ============================================================
// 桥接 API（IndexStore worker 提供实现；注入式接线，未注册时零行为变化）
// ============================================================

export type WikiIndexObjectType = 'wiki_page' | 'knowledge_note' | 'entity' | 'topic' | 'source' | 'fixed_version_reference';

/** 一条索引条目（映射 IndexStore 的 knowledge_index_entries 单行；字段与统一搜索契约对齐）。 */
export type WikiIndexEntryInput = Readonly<{
  objectType: WikiIndexObjectType;
  objectId: string;
  /**
   * 固定版本/修订锚（与 IndexStore rebuild 字节一致，migration 63 knowledge_index_entries.version_ref）：
   * - wiki_page / knowledge_note → 当前不可变版本 id（裸 id；无版本回退 `rev:{revision}`）；
   * - entity / topic → `rev:{revision}`；
   * - source → 最新 source_body_revisions.id（裸 id；无正文 revision 回退 `rev:{source revision}`）；
   * - fixed_version_reference → 被引用版本 id（裸 id）。
   */
  versionRef: string;
  title: string;
  summary: string;
  /** 预压平可搜索文本（有界 ~8KB；IndexStore 表列 searchable_text）。 */
  searchableText: string;
  updatedAt: string;
  /** 可导航定位（resolveKnowledgeDeepLink 载荷 shape，同 ID 空间）。 */
  locator: Readonly<Record<string, unknown>>;
  scope?: string;
  compileStatus?: string | null;
  topicIds?: readonly string[];
  navObjectType?: string | null;
  navObjectId?: string | null;
}>;

export type WikiIndexProjectionApi = Readonly<{
  /**
   * 幂等 upsert（按 objectType+objectId；PK 冲突覆盖当前行）。transaction=false 时调用方负责
   * 原子性（本模块以 SAVEPOINT 包裹）；调用方在 dispatcher/独立连接事务内必须传 false。
   */
  upsertIndexEntries(database: DatabaseSync, entries: readonly WikiIndexEntryInput[], transaction?: boolean): number;
  /** 删除/归档/终结对象 → 批量移除索引条目（同 transaction 语义）。 */
  removeIndexEntries(database: DatabaseSync, keys: readonly { objectType: WikiIndexObjectType; objectId: string }[], transaction?: boolean): void;
  /** 可重建兜底（全量重建索引；投影失败后的自愈入口）。 */
  rebuildWikiIndex?(database: DatabaseSync, transaction?: boolean): unknown;
}>;

const projectionState: { api: WikiIndexProjectionApi | null } = { api: null };

/** 注册投影 API（生产接线在 index.ts 启动时调用；测试可注入 test double）。 */
export function setWikiIndexProjectionApi(api: WikiIndexProjectionApi | null): void {
  projectionState.api = api;
}

export function getWikiIndexProjectionApi(): WikiIndexProjectionApi | null {
  return projectionState.api;
}

/** 注册 ChangeSet 提交后投影 hook（幂等：重复注册覆盖同一回调）。 */
export function registerWikiIndexProjection(): void {
  setKnowledgeChangeSetIndexTrigger((ctx) => {
    projectChangeSet(ctx);
  });
}

// ============================================================
// 写隔离：SAVEPOINT 包裹 + 失败零阻断
// ============================================================

const PROJECTION_SAVEPOINT = 'wmb_wiki_index_projection';

function applyProjectionWrite(database: DatabaseSync, fn: () => void): void {
  const api = projectionState.api;
  if (!api) return;
  database.exec(`SAVEPOINT ${PROJECTION_SAVEPOINT}`);
  try {
    fn();
    database.exec(`RELEASE ${PROJECTION_SAVEPOINT}`);
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO ${PROJECTION_SAVEPOINT}; RELEASE ${PROJECTION_SAVEPOINT}`);
    } catch {
      // 回滚失败不掩盖根因
    }
    console.error('[wiki-index] projection write failed; business write kept, index needs rebuild (rebuildWikiIndex)', error);
  }
}

function withProjectionApi(fn: (api: WikiIndexProjectionApi) => void): void {
  const api = projectionState.api;
  if (!api) return;
  try {
    fn(api);
  } catch (error) {
    console.error('[wiki-index] projection failed; business write kept, index needs rebuild (rebuildWikiIndex)', error);
  }
}

// ============================================================
// ChangeSet 提交后投影（知识编译 / Wiki 版本 / Query 写回 / Lint / 维护修复 / 初始化 / 反馈）
// ============================================================

function projectChangeSet(ctx: KnowledgeChangeSetIndexTriggerContext): void {
  const api = projectionState.api;
  if (!api) return;
  const { database, input } = ctx;
  const entries: WikiIndexEntryInput[] = [];
  const removals: Array<{ objectType: WikiIndexObjectType; objectId: string }> = [];
  const versionRefs: Array<{ kind: 'note' | 'wiki_page'; versionId: string }> = [];

  for (const write of input.entities ?? []) {
    const id = resolveEntityId(database, write);
    if (!id) continue;
    if (write.lifecycle && write.lifecycle !== 'active') {
      removals.push({ objectType: 'entity', objectId: id });
      continue;
    }
    const entry = buildEntityEntry(database, id);
    if (entry && !('remove' in entry)) entries.push(entry);
  }
  for (const write of input.notes ?? []) {
    const id = resolveNoteId(database, write);
    if (!id) continue;
    if (write.lifecycle && write.lifecycle !== 'active') {
      removals.push({ objectType: 'knowledge_note', objectId: id });
      continue;
    }
    const entry = buildNoteEntry(database, id);
    if (entry && !('remove' in entry)) entries.push(entry);
    if (write.version?.versionId) versionRefs.push({ kind: 'note', versionId: write.version.versionId });
  }
  for (const write of input.wikiPages ?? []) {
    const id = resolveWikiPageId(database, write);
    if (!id) continue;
    if (write.lifecycle && write.lifecycle !== 'active') {
      removals.push({ objectType: 'wiki_page', objectId: id });
      continue;
    }
    const entry = buildWikiPageEntry(database, id);
    if (entry && !('remove' in entry)) entries.push(entry);
    if (write.version?.versionId) versionRefs.push({ kind: 'wiki_page', versionId: write.version.versionId });
  }
  // 固定版本引用：证据链接引用的 note 版本 + 回执声明的 wiki page 版本。
  for (const link of input.evidenceLinks ?? []) {
    if (link.knowledgeNoteVersionId) versionRefs.push({ kind: 'note', versionId: link.knowledgeNoteVersionId });
  }
  for (const receipt of input.receipts ?? []) {
    for (const versionId of receipt.wikiPageVersions ?? []) versionRefs.push({ kind: 'wiki_page', versionId });
  }
  for (const ref of dedupeVersionRefs(versionRefs)) {
    const entry = buildFixedVersionReferenceEntry(database, ref.kind, ref.versionId);
    if (entry) entries.push(entry);
  }

  if (!entries.length && !removals.length) return;
  applyProjectionWrite(database, () => {
    if (entries.length) api.upsertIndexEntries(database, entries, false);
    if (removals.length) api.removeIndexEntries(database, removals, false);
  });
}

function dedupeVersionRefs(refs: Array<{ kind: 'note' | 'wiki_page'; versionId: string }>): Array<{ kind: 'note' | 'wiki_page'; versionId: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: 'note' | 'wiki_page'; versionId: string }> = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.versionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ---- 创建对象 id 解析（创建写入可能省略 id，提交后按 (scope, canonical_key) 读回） ----

function resolveEntityId(database: DatabaseSync, write: { id?: string; scope: string; canonicalKey: string }): string | null {
  if (write.id) return write.id;
  const row = database.prepare(
    'SELECT id FROM knowledge_entities WHERE scope = ? AND canonical_key = ? ORDER BY rowid DESC LIMIT 1'
  ).get(write.scope, normalizeCanonicalKeyLocal(write.canonicalKey)) as { id: string } | undefined;
  return row?.id ?? null;
}

function resolveNoteId(database: DatabaseSync, write: { id?: string; scope: string; canonicalKey: string }): string | null {
  if (write.id) return write.id;
  const row = database.prepare(
    'SELECT id FROM knowledge_notes WHERE scope = ? AND canonical_key = ? ORDER BY rowid DESC LIMIT 1'
  ).get(write.scope, normalizeCanonicalKeyLocal(write.canonicalKey)) as { id: string } | undefined;
  return row?.id ?? null;
}

function resolveWikiPageId(database: DatabaseSync, write: { id?: string; scope: string; canonicalKey: string }): string | null {
  if (write.id) return write.id;
  const row = database.prepare(
    'SELECT id FROM knowledge_wiki_pages WHERE scope = ? AND canonical_key = ? ORDER BY rowid DESC LIMIT 1'
  ).get(write.scope, normalizeCanonicalKeyLocal(write.canonicalKey)) as { id: string } | undefined;
  return row?.id ?? null;
}

function normalizeCanonicalKeyLocal(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ============================================================
// 条目构建（读回当前状态；直接查表，避免与写路径模块形成 import 环）
// ============================================================

const SEARCHABLE_TEXT_LIMIT = 8000;

function boundedText(value: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > SEARCHABLE_TEXT_LIMIT ? trimmed.slice(0, SEARCHABLE_TEXT_LIMIT) : trimmed;
}

function joinSearchable(parts: Array<string | null | undefined>): string {
  return boundedText(parts.filter((part): part is string => Boolean(part && part.trim())).join('\n'));
}

function deepLinkLocator(database: DatabaseSync, objectType: string, objectId: string): Readonly<Record<string, unknown>> {
  try {
    return resolveKnowledgeDeepLink(database, { objectType, objectId });
  } catch {
    return Object.freeze({ objectType, objectId, title: '', route: 'object', targetType: 'knowledge_object', targetId: objectId, exists: false, formalObjectType: null, formalObjectId: null });
  }
}

type Indexable = WikiIndexEntryInput | { remove: true };

function buildWikiPageEntry(database: DatabaseSync, id: string): Indexable | null {
  const current = getWikiPage(database, id);
  if (!current) return null;
  const { page, version } = current;
  if (page.lifecycle !== 'active') return { remove: true };
  const title = version?.title || page.title;
  const bodySummary = extractBodySummary(version?.body);
  const summary = bodySummary || version?.changeSummary || '';
  const searchableText = joinSearchable([
    title, summary,
    version?.changeSummary,
    version?.readableDiff,
    ...extractBodyTextParts(version?.body)
  ]);
  const locator = deepLinkLocator(database, 'wiki_page', id);
  const navObjectType = page.subjectType === 'topic' ? 'topic' : page.subjectType === 'entity' ? 'knowledge_entity' : page.subjectType ?? null;
  const navObjectId = page.subjectId;
  return {
    objectType: 'wiki_page',
    objectId: id,
    versionRef: version?.id ?? `rev:${page.revision}`,
    title,
    summary,
    searchableText,
    updatedAt: version?.createdAt ?? page.updatedAt,
    locator,
    scope: page.scope,
    compileStatus: page.compileStatus,
    topicIds: page.subjectType === 'topic' && page.subjectId ? [page.subjectId] : [],
    navObjectType,
    navObjectId
  };
}

function buildNoteEntry(database: DatabaseSync, id: string): Indexable | null {
  const current = getKnowledgeNote(database, id);
  if (!current) return null;
  const { note, version } = current;
  if (note.lifecycle !== 'active') return { remove: true };
  const title = version?.title || note.title;
  const summary = version?.statement || '';
  const searchableText = joinSearchable([
    title, version?.statement, version?.body, version?.appliesTo,
    version?.changeReason, version?.conclusionStatus, version?.evidenceLevel
  ]);
  return {
    objectType: 'knowledge_note',
    objectId: id,
    versionRef: version?.id ?? `rev:${note.revision}`,
    title,
    summary,
    searchableText,
    updatedAt: version?.createdAt ?? note.updatedAt,
    locator: deepLinkLocator(database, 'knowledge_note', id),
    scope: note.scope,
    compileStatus: null,
    topicIds: version?.adoptedTopicIds ?? [],
    navObjectType: 'knowledge_note',
    navObjectId: id
  };
}

function buildEntityEntry(database: DatabaseSync, id: string): Indexable | null {
  const current = getKnowledgeEntity(database, id);
  if (!current) return null;
  const { entity } = current;
  if (entity.lifecycle !== 'active') return { remove: true };
  const summary = entity.aliases.join('、');
  return {
    objectType: 'entity',
    objectId: id,
    versionRef: `rev:${entity.revision}`,
    title: entity.canonicalName,
    summary,
    searchableText: joinSearchable([entity.canonicalName, entity.aliases.join(' '), entity.canonicalKey, entity.entityType]),
    updatedAt: entity.updatedAt,
    locator: deepLinkLocator(database, 'knowledge_entity', id),
    scope: entity.scope,
    compileStatus: null,
    topicIds: [],
    navObjectType: 'knowledge_entity',
    navObjectId: id
  };
}

function buildTopicEntry(database: DatabaseSync, id: string): Indexable | null {
  const row = database.prepare(
    'SELECT title, summary, status, revision, updated_at AS updatedAt FROM topics WHERE id = ?'
  ).get(id) as { title: string; summary: string | null; status: string; revision: number; updatedAt: string } | undefined;
  if (!row) return null;
  if (row.status === 'archived') return { remove: true };
  return {
    objectType: 'topic',
    objectId: id,
    versionRef: `rev:${row.revision}`,
    title: row.title,
    summary: row.summary ?? '',
    searchableText: joinSearchable([row.title, row.summary]),
    updatedAt: row.updatedAt,
    locator: deepLinkLocator(database, 'topic', id),
    scope: 'global',
    compileStatus: null,
    topicIds: [id],
    navObjectType: 'topic',
    navObjectId: id
  };
}

function buildSourceEntry(database: DatabaseSync, id: string): Indexable | null {
  const row = database.prepare(`SELECT title, author, summary, canonical_url AS canonicalUrl, original_url AS originalUrl,
    management_status AS managementStatus, revision, updated_at AS updatedAt FROM source_items WHERE id = ?`)
    .get(id) as { title: string; author: string | null; summary: string | null; canonicalUrl: string | null; originalUrl: string | null; managementStatus: string; revision: number; updatedAt: string } | undefined;
  if (!row) return null;
  if (row.managementStatus === 'archived') return { remove: true };
  const bodyRevision = latestSourceBodyRevision(database, id);
  const bodyText = bodyRevision?.text ?? null;
  // 与 rebuildWikiIndex 同源：topic_ids_json 来自 topic_source_links（topicId 过滤一致）。
  let topicIds: string[] = [];
  try {
    const links = database.prepare(
      'SELECT topic_id AS topicId FROM topic_source_links WHERE source_id = ? ORDER BY topic_id'
    ).all(id) as unknown[];
    topicIds = links.map((row) => {
      const value = (row as Record<string, unknown>).topicId;
      return typeof value === 'string' ? value : '';
    }).filter(Boolean);
  } catch {
    // 精简 fixture 缺 topic_source_links → 空
  }
  return {
    objectType: 'source',
    objectId: id,
    // 固定版本锚：有正文 revision 时指向最新正文固定版本（与 IndexStore rebuild 语义一致），
    // 否则回退到 source_items revision（无版本表的 revision 锚）。
    versionRef: bodyRevision?.revisionId ?? `rev:${row.revision}`,
    title: row.title,
    summary: row.summary ?? '',
    searchableText: joinSearchable([row.title, row.summary, row.author, row.canonicalUrl, row.originalUrl, bodyText]),
    updatedAt: row.updatedAt,
    locator: deepLinkLocator(database, 'source', id),
    scope: 'global',
    compileStatus: null,
    topicIds,
    navObjectType: 'source',
    navObjectId: id
  };
}

function latestSourceBodyRevision(database: DatabaseSync, sourceId: string): { revisionId: string; createdAt: string; text: string | null } | null {
  try {
    const row = database.prepare(
      "SELECT id AS revisionId, created_at AS createdAt, extracted_text AS text FROM source_body_revisions WHERE source_id = ? AND status = 'ready' AND length(extracted_text) > 0 ORDER BY rowid DESC LIMIT 1"
    ).get(sourceId) as { revisionId: string; createdAt: string; text: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function buildFixedVersionReferenceEntry(database: DatabaseSync, kind: 'note' | 'wiki_page', versionId: string): WikiIndexEntryInput | null {
  if (kind === 'note') {
    const version = getKnowledgeNoteVersion(database, versionId);
    if (!version) return null;
    const locator = deepLinkLocator(database, 'knowledge_note', version.noteId);
    return {
      objectType: 'fixed_version_reference',
      objectId: versionId,
      versionRef: versionId,
      title: version.title || version.statement.slice(0, 80),
      summary: version.statement,
      searchableText: joinSearchable([version.title, version.statement, version.body, version.appliesTo, version.changeReason]),
      updatedAt: version.createdAt,
      locator,
      scope: nullScope(database, version.noteId),
      compileStatus: null,
      topicIds: version.adoptedTopicIds ?? [],
      navObjectType: 'knowledge_note',
      navObjectId: version.noteId
    };
  }
  const version = getWikiPageVersion(database, versionId);
  if (!version) return null;
  const pageId = version.pageId;
  const locator = deepLinkLocator(database, 'wiki_page', pageId);
  const pageScope = pageScopeOf(database, pageId);
  // 与 rebuildWikiIndex 同源：topic 主题页的版本引用行携带主题 topicId（topicId 过滤一致）。
  let topicIds: string[] = [];
  try {
    const row = database.prepare(
      'SELECT subject_type AS subjectType, subject_id AS subjectId FROM knowledge_wiki_pages WHERE id = ?'
    ).get(pageId) as { subjectType: string | null; subjectId: string | null } | undefined;
    if (row && row.subjectType === 'topic' && row.subjectId) topicIds = [row.subjectId];
  } catch {
    // 精简 fixture 缺 v56 表 → 空
  }
  return {
    objectType: 'fixed_version_reference',
    objectId: versionId,
    versionRef: versionId,
    title: version.title,
    summary: version.changeSummary,
    searchableText: joinSearchable([version.title, version.changeSummary, version.readableDiff, ...extractBodyTextParts(version.body)]),
    updatedAt: version.createdAt,
    locator,
    scope: pageScope ?? undefined,
    compileStatus: null,
    topicIds,
    navObjectType: 'wiki_page',
    navObjectId: pageId
  };
}

function nullScope(database: DatabaseSync, noteId: string): string | undefined {
  try {
    const row = database.prepare('SELECT scope FROM knowledge_notes WHERE id = ?').get(noteId) as { scope: string } | undefined;
    return row?.scope;
  } catch {
    return undefined;
  }
}

function pageScopeOf(database: DatabaseSync, pageId: string): string | null {
  try {
    const row = database.prepare('SELECT scope FROM knowledge_wiki_pages WHERE id = ?').get(pageId) as { scope: string } | undefined;
    return row?.scope ?? null;
  } catch {
    return null;
  }
}

/** topic-wiki 正文 Record 的摘要字段（body.kind='topic-wiki' 时）。 */
function extractBodySummary(body: Readonly<Record<string, unknown>> | undefined): string {
  if (!body || typeof body !== 'object') return '';
  const summary = body['summary'];
  return typeof summary === 'string' ? summary : '';
}

/** 把 wiki page 版本正文 Record 压平成可搜索文本片段（只取有界已知结构，不做通用递归）。 */
function extractBodyTextParts(body: Readonly<Record<string, unknown>> | undefined): string[] {
  if (!body || typeof body !== 'object') return [];
  const parts: string[] = [];
  const pushStringArray = (key: string): void => {
    const value = body[key];
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Readonly<Record<string, unknown>>;
      for (const field of ['statement', 'title', 'changeType', 'conclusionStatus'] as const) {
        const text = record[field];
        if (typeof text === 'string' && text.trim()) parts.push(text.trim());
      }
    }
  };
  pushStringArray('keyConclusions');
  pushStringArray('retainedDisputes');
  pushStringArray('pendingQuestions');
  pushStringArray('recentChanges');
  for (const key of ['title', 'summary', 'readableDiff'] as const) {
    const text = body[key];
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  return parts;
}

// ============================================================
// 非 ChangeSet 写路径投影（Source 保存 / Source 正文 / Topic）
// ============================================================

/**
 * Source 保存成功后的增量投影（upsertSource / updateKnowledgeSource / deleteKnowledgeSource
 * 成功提交点调用）。已归档/已删除 → 移除索引条目；否则 upsert 当前状态。
 * 全局时间日志侧：Source 正文摄取由 source_body_revisions 派生覆盖；本函数不做日志写。
 */
export function projectSourceSaved(database: DatabaseSync, sourceId: string): void {
  withProjectionApi((api) => {
    const entry = buildSourceEntry(database, sourceId);
    if (entry && 'remove' in entry) {
      applyProjectionWrite(database, () => api.removeIndexEntries(database, [{ objectType: 'source', objectId: sourceId }], false));
      return;
    }
    if (!entry) {
      // 对象已删除 → 索引条目必须移除（deleteKnowledgeSource 成功提交后调用本函数）。
      applyProjectionWrite(database, () => api.removeIndexEntries(database, [{ objectType: 'source', objectId: sourceId }], false));
      return;
    }
    applyProjectionWrite(database, () => { api.upsertIndexEntries(database, [entry], false); });
  });
}

/**
 * Source 正文固定版本落地后的增量投影（writeSourceBodyCache 追加新 revision 后调用）。
 * 刷新 source 索引条目（正文进入 searchableText）；同 hash 幂等（未追加 revision）时不调用本函数。
 * 全局时间日志侧：正文摄取事件由 source_body_revisions 派生覆盖（sourceRows 源）。
 */
export function projectSourceBodyRevision(database: DatabaseSync, sourceId: string): void {
  withProjectionApi((api) => {
    const entry = buildSourceEntry(database, sourceId);
    if (!entry || 'remove' in entry) return;
    const entries: WikiIndexEntryInput[] = [entry];
    // 固定版本引用行（与 rebuildWikiIndex 的 source 正文 fvr 行同构）：新正文 revision 是
    // 不可变版本，必须可被统一搜索/固定引用命中；对象 id = revision id（同重建语义）。
    const revision = latestSourceBodyRevision(database, sourceId);
    if (revision) {
      entries.push({
        objectType: 'fixed_version_reference',
        objectId: revision.revisionId,
        versionRef: revision.revisionId,
        title: entry.title,
        summary: '',
        searchableText: boundedText(revision.text ?? ''),
        topicIds: entry.topicIds,
        scope: entry.scope ?? 'global',
        compileStatus: entry.compileStatus ?? null,
        updatedAt: revision.createdAt,
        locator: deepLinkLocator(database, 'source', sourceId),
        navObjectType: 'source',
        navObjectId: sourceId
      });
    }
    applyProjectionWrite(database, () => { api.upsertIndexEntries(database, entries, false); });
  });
}

/**
 * Topic 保存/状态变化后的增量投影（upsertKnowledgeTopic / topic-maintenance executeFrozen
 * 成功提交点调用）。已归档 → 移除索引条目；否则 upsert 当前状态。
 */
export function projectTopicSaved(database: DatabaseSync, topicId: string): void {
  withProjectionApi((api) => {
    const entry = buildTopicEntry(database, topicId);
    if (entry && 'remove' in entry) {
      applyProjectionWrite(database, () => api.removeIndexEntries(database, [{ objectType: 'topic', objectId: topicId }], false));
      return;
    }
    if (!entry) return;
    applyProjectionWrite(database, () => { api.upsertIndexEntries(database, [entry], false); });
  });
}

// ============================================================
// 生产接线（index.ts 启动时调用；IndexStore 模块经动态导入，缺模块不阻断启动）
// ============================================================

/**
 * 生产投影接线：动态导入 IndexStore 模块并注册投影 API + ChangeSet hook。
 * 失败（模块尚未落地/导出变化）→ 记录并保持未接线状态（零行为变化），应用照常启动；
 * 索引可经 rebuildWikiIndex 兜底重建。幂等：重复调用覆盖同一注册。
 */
export async function installProductionWikiIndexProjection(): Promise<boolean> {
  try {
    const store = await import('./db/wiki-index-store.ts');
    const api: WikiIndexProjectionApi = {
      upsertIndexEntries: store.upsertIndexEntries as WikiIndexProjectionApi['upsertIndexEntries'],
      removeIndexEntries: store.removeIndexEntries as WikiIndexProjectionApi['removeIndexEntries'],
      rebuildWikiIndex: (store.rebuildWikiIndex as WikiIndexProjectionApi['rebuildWikiIndex']) ?? undefined
    };
    setWikiIndexProjectionApi(api);
    registerWikiIndexProjection();
    return true;
  } catch (error) {
    console.error('[wiki-index] production projection wiring unavailable (wiki-index-store module not ready?)', error);
    return false;
  }
}
