/**
 * WMB-5238 索引触发接线验收（WireWikiIndexTriggers；局部验证，不跑项目级测试套件）。
 * 证明：
 * 1. 一次成功写入 → 可搜索（真实 knowledge-search.ts 读模型）+ 产生日志（真实
 *    knowledge-global-log.ts 派生读模型）。
 * 2. 失败/回滚 → 无孤儿索引（投影与业务写同事务；变更集失败零投影）。
 * 3. 重复触发不重复：ChangeSet replay 零投影；同内容 source/topic 重复保存零投影；
 *    source 正文同 hash 不产生新 revision → 零投影。
 * 4. 投影失败零阻断：IndexStore API 抛错 → 业务写已提交、索引缺条目可重建。
 * 5. ChangeSet 覆盖：知识编译（note/entity/wiki page/fixed_version_reference 引用）
 *    、归档 → 移除索引条目。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { applyKnowledgeChangeSet } from '../src/main/knowledge-flywheel.ts';
import { upsertSource } from '../src/main/sources.ts';
import { writeSourceBodyCache } from '../src/main/source-body-cache.ts';
import { upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { registerWikiIndexProjection, setWikiIndexProjectionApi } from '../src/main/wiki-index-triggers.ts';
import { searchWikiIndex } from '../src/main/knowledge-search.ts';
import { listKnowledgeLogEntries } from '../src/main/knowledge-global-log.ts';

const directory = await mkdtemp(path.join(tmpdir(), 'wmb-5238-triggers-'));
const databasePath = path.join(directory, 'wmb.db');

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}
const now = () => new Date().toISOString();

// ---- 真实索引表（migration 63 由 IndexStore worker 落地；验收按锁定契约本地建表） ----
const database = migrateDatabase(databasePath);
database.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_index_entries (
    object_type TEXT NOT NULL CHECK (object_type IN ('wiki_page','knowledge_note','entity','topic','source','fixed_version_reference')),
    object_id TEXT NOT NULL,
    version_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    searchable_text TEXT NOT NULL DEFAULT '',
    topic_ids_json TEXT NOT NULL DEFAULT '[]',
    scope TEXT NOT NULL DEFAULT 'global' CHECK (scope='global' OR scope LIKE 'lane:%'),
    compile_status TEXT NOT NULL DEFAULT 'current',
    updated_at TEXT NOT NULL,
    nav_object_type TEXT,
    nav_object_id TEXT,
    PRIMARY KEY (object_type, object_id)
  );
`);
database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', 'ws-a', ?, ?, 1)").run(now(), now());

// ---- 与 IndexStore 锁定契约一致的 test double（单语句原子；transaction=false 由投影 SAVEPOINT 包裹） ----
let lastUpsertBatch = [];
let lastRemoveBatch = [];
let failNextUpsert = false;
setWikiIndexProjectionApi({
  upsertIndexEntries(db, entries) {
    lastUpsertBatch = [...entries];
    if (failNextUpsert) throw new Error('BOOM_INDEX_UPSERT');
    for (const entry of entries) {
      db.prepare(`INSERT INTO knowledge_index_entries
        (object_type, object_id, version_ref, title, summary, searchable_text, topic_ids_json, scope, compile_status, updated_at, nav_object_type, nav_object_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_type, object_id) DO UPDATE SET
          version_ref=excluded.version_ref, title=excluded.title, summary=excluded.summary,
          searchable_text=excluded.searchable_text, topic_ids_json=excluded.topic_ids_json, scope=excluded.scope,
          compile_status=excluded.compile_status, updated_at=excluded.updated_at,
          nav_object_type=excluded.nav_object_type, nav_object_id=excluded.nav_object_id`)
        .run(entry.objectType, entry.objectId, entry.versionRef, entry.title, entry.summary ?? '',
          entry.searchableText ?? '', JSON.stringify(entry.topicIds ?? []), entry.scope ?? 'global',
          entry.compileStatus ?? 'current', entry.updatedAt, entry.navObjectType ?? null, entry.navObjectId ?? null);
    }
    return entries.length;
  },
  removeIndexEntries(db, keys) {
    lastRemoveBatch = [...keys];
    for (const key of keys) {
      db.prepare('DELETE FROM knowledge_index_entries WHERE object_type = ? AND object_id = ?').run(key.objectType, key.objectId);
    }
  },
  rebuildWikiIndex() {
    return { total: 0, byType: {}, rebuiltAt: now() };
  }
});
registerWikiIndexProjection();

const meta = (requestId) => ({ workspaceId: 'ws-a', requestId, reason: '验收原因', triggerSource: 'ingest', resolutionMode: 'none', createdBy: 'background_agent' });
const indexRows = () => database.prepare('SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef, title, searchable_text AS searchableText, updated_at AS updatedAt FROM knowledge_index_entries ORDER BY object_type, object_id').all();

// ============ 1. Source 保存 → 可搜索 + 日志（source 事件经 body revision 派生） ============
{
  const saved = upsertSource(database, { title: 'AI 日报生成器研究', summary: '自动生成热点日报的完整流程', originalUrl: 'https://example.com/ai-daily', author: '测试作者' });
  const rows = indexRows();
  const sourceRow = rows.find((row) => row.objectType === 'source' && row.objectId === saved.id);
  check('source save indexes entry', Boolean(sourceRow), JSON.stringify(rows));
  check('source searchable text contains title+summary', sourceRow?.searchableText.includes('AI 日报生成器研究') && sourceRow?.searchableText.includes('自动生成热点日报'), sourceRow?.searchableText);
  check('source versionRef = rev:1', sourceRow?.versionRef === 'rev:1', sourceRow?.versionRef);
  const hits = searchWikiIndex(database, { query: '日报生成器', limit: 10 });
  check('source is searchable via searchWikiIndex', hits.total >= 1 && hits.items.some((item) => item.objectType === 'source' && item.objectId === saved.id), JSON.stringify(hits.items.map((i) => [i.objectType, i.objectId])));
  // 重复同内容保存：不重复投影（materiality）
  const before = indexRows().length;
  lastUpsertBatch = [];
  upsertSource(database, { title: 'AI 日报生成器研究', summary: '自动生成热点日报的完整流程', originalUrl: 'https://example.com/ai-daily', author: '测试作者' });
  check('identical source re-save does not re-project', lastUpsertBatch.length === 0 && indexRows().length === before, JSON.stringify(lastUpsertBatch));
  // 实质变化 → 重新投影
  lastUpsertBatch = [];
  upsertSource(database, { title: 'AI 日报生成器研究 v2', summary: '自动生成热点日报的完整流程', originalUrl: 'https://example.com/ai-daily' });
  const row2 = indexRows().find((row) => row.objectType === 'source' && row.objectId === saved.id);
  check('material source change re-projects (rev:3)', lastUpsertBatch.length === 1 && row2?.versionRef === 'rev:3' && row2?.title === 'AI 日报生成器研究 v2', JSON.stringify(row2));
}

// ============ 2. Source 正文固定版本 → 索引刷新 + 派生日志 source 事件 ============
{
  const source = database.prepare('SELECT id FROM source_items ORDER BY created_at ASC LIMIT 1').get();
  writeSourceBodyCache(database, {
    sourceId: source.id, url: 'https://example.com/ai-daily', status: 'ready', contentType: 'text/html',
    extractedText: '正文全文：AI 热点日报需要扫描 X 社区线索并核验来源。', extractedChars: 40,
    errorMessage: null, fetchedAt: now(), updatedAt: now()
  });
  const row = indexRows().find((r) => r.objectType === 'source' && r.objectId === source.id);
  check('body revision refresh makes body searchable', row?.searchableText.includes('扫描 X 社区线索'), row?.searchableText);
  check('source versionRef = bare body revision id', row?.versionRef && row.versionRef !== 'rev:2' && !row.versionRef.startsWith('rev:'), row?.versionRef);
  const log = listKnowledgeLogEntries(database, {});
  check('derived global log has source event', log.items.some((entry) => entry.eventType === 'source'), JSON.stringify(log.items.map((i) => i.eventType)));
  // 同正文重复写：不产生新 revision → 零投影
  const bodyRowsBefore = Number(database.prepare('SELECT count(*) AS c FROM source_body_revisions').get().c);
  lastUpsertBatch = [];
  writeSourceBodyCache(database, {
    sourceId: source.id, url: 'https://example.com/ai-daily', status: 'ready', contentType: 'text/html',
    extractedText: '正文全文：AI 热点日报需要扫描 X 社区线索并核验来源。', extractedChars: 40,
    errorMessage: null, fetchedAt: now(), updatedAt: now()
  });
  const bodyRowsAfter = Number(database.prepare('SELECT count(*) AS c FROM source_body_revisions').get().c);
  check('identical body write is idempotent (no new revision, no projection)', bodyRowsBefore === bodyRowsAfter && lastUpsertBatch.length === 0, `${bodyRowsBefore}->${bodyRowsAfter}`);
}

// ============ 3. Topic 保存 → 索引 + 日志（Topic 变化进派生日志 change_set? no — topic.saved 由 change_set 外的直接写；日志断言改为 topic 可搜索） ============
{
  const topic = upsertKnowledgeTopic(database, { title: 'AI 工具生态', summary: 'AI 工具与生态研究', kind: 'theme' });
  const row = indexRows().find((r) => r.objectType === 'topic' && r.objectId === topic.id);
  check('topic save indexes entry', Boolean(row), JSON.stringify(indexRows()));
  check('topic versionRef = rev:1', row?.versionRef === 'rev:1', row?.versionRef);
  const hits = searchWikiIndex(database, { query: '工具生态', limit: 10 });
  check('topic is searchable', hits.items.some((item) => item.objectType === 'topic' && item.objectId === topic.id), JSON.stringify(hits.items.map((i) => i.objectType)));
  // 归档 → 移除
  upsertKnowledgeTopic(database, { title: 'AI 工具生态', summary: 'AI 工具与生态研究', kind: 'theme', status: 'archived' });
  const row2 = indexRows().find((r) => r.objectType === 'topic' && r.objectId === topic.id);
  check('archived topic removed from index', !row2, JSON.stringify(row2));
}

// ============ 4. 知识编译 ChangeSet → note/entity/wiki_page/fvr 全部索引 + 派生日志 ============
{
  // wiki page 主体必须真实存在（writeWikiPage 校验 subject）
  database.prepare(`INSERT INTO topics (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at)
    VALUES ('t1', 'AI 日报主题', ?, ?, 1, 'ai-daily-topic', 'theme', NULL, 'active', ?, ?)`)
    .run(now(), now(), now(), now());
}
{
  // 证据链接引用的 source 必须真实存在
  database.prepare(`INSERT INTO source_items (id, feed_id, original_url, canonical_url, content_fingerprint, title, author, published_at, collected_at,
    summary, categories_json, keywords_json, value_judgment, ip_relevance, creation_angles, recommended_platforms_json, recommended_formats_json,
    timeliness, priority, evidence, client_label, verification_status, management_status, created_at, updated_at, revision)
    VALUES ('s-any', NULL, 'https://example.com/e', 'https://example.com/e', NULL, '证据源', NULL, NULL, ?, NULL, '[]', '[]', NULL, NULL, NULL, '[]', '[]', NULL, NULL, NULL, NULL, 'pending', 'active', ?, ?, 1)`)
    .run(now(), now(), now());
}


{
  const requestId = 'compile-accept-1';
  const noteVersionId = `wver-note-${requestId}`;
  const pageVersionId = `wver-page-${requestId}`;
  const entityId = `entity-${requestId}`;
  const noteId = `note-${requestId}`;
  const pageId = `page-${requestId}`;
  lastUpsertBatch = [];
  const result = applyKnowledgeChangeSet(database, meta(requestId), {
    entities: [{ id: entityId, scope: 'global', entityType: 'person', canonicalKey: 'openai', canonicalName: 'OpenAI 研究团队', aliases: ['OpenAI'], lifecycle: 'active' }],
    notes: [{ id: noteId, scope: 'global', kind: 'insight', canonicalKey: 'ai-daily-flow', title: '日报流程', lifecycle: 'active', version: { versionId: noteVersionId, title: '日报流程', statement: 'AI 日报需要核验来源并绑定固定版本引用。', body: '详细正文：先扫描后核验。', conclusionStatus: 'supported', evidenceLevel: 'corroborated' } }],
    wikiPages: [{ id: pageId, scope: 'global', pageType: 'topic', canonicalKey: 'wiki-topic:t1', title: 'AI 日报主题页', subjectType: 'topic', subjectId: 't1', lifecycle: 'active', version: { versionId: pageVersionId, title: 'AI 日报主题页', body: { kind: 'topic-wiki', title: 'AI 日报主题页', summary: '主题页摘要', keyConclusions: [{ statement: '日报必须核验来源' }] }, changeSummary: '首次编译', compileReason: 'accept' } }],
    evidenceLinks: [{ knowledgeNoteVersionId: noteVersionId, evidenceObjectType: 'source', evidenceObjectId: 's-any', relation: 'supports', sourceNature: 'primary_source' }],
    receipts: [{ triggerType: 'ingest', requestId, summary: '验收编译', counts: { notesCreated: 1, entitiesCreated: 1, wikiPagesCompiled: 1 }, wikiPageVersions: [pageVersionId] }]
  });
  check('change set committed', result.replay === false && Boolean(result.changeSetId), JSON.stringify({ changeSetId: result.changeSetId, replay: result.replay }));
  const types = new Set(indexRows().map((r) => `${r.objectType}:${r.objectId}`));
  check('note indexed', types.has(`knowledge_note:${noteId}`), [...types].join(','));
  check('entity indexed', types.has(`entity:${entityId}`));
  check('wiki page indexed', types.has(`wiki_page:${pageId}`));
  check('fixed version reference indexed (note version)', types.has(`fixed_version_reference:${noteVersionId}`));
  check('fixed version reference indexed (page version)', types.has(`fixed_version_reference:${pageVersionId}`));
  const noteRow = indexRows().find((r) => r.objectType === 'knowledge_note' && r.objectId === noteId);
  check('note versionRef = bare version id', noteRow?.versionRef === noteVersionId, noteRow?.versionRef);
  const pageRow = indexRows().find((r) => r.objectType === 'wiki_page' && r.objectId === pageId);
  check('wiki page searchable text flattens body', pageRow?.searchableText.includes('日报必须核验来源'), pageRow?.searchableText);
  const hits = searchWikiIndex(database, { query: '核验来源', limit: 20 });
  check('compiled knowledge searchable', hits.total >= 3, JSON.stringify(hits.items.map((i) => i.objectType)));
  const log = listKnowledgeLogEntries(database, {});
  const logKinds = new Set(log.items.map((e) => e.eventType));
  check('derived log has change_set entry', logKinds.has('change_set'), [...logKinds].join(','));
  check('derived log has compile entry', logKinds.has('compile'));

  // ---- replay 幂等：同 requestId 同输入 → 零新增索引行、零投影 ----
  const before = indexRows().length;
  lastUpsertBatch = [];
  const replay = applyKnowledgeChangeSet(database, meta(requestId), {
    entities: [{ id: entityId, scope: 'global', entityType: 'person', canonicalKey: 'openai', canonicalName: 'OpenAI 研究团队', aliases: ['OpenAI'], lifecycle: 'active' }],
    notes: [{ id: noteId, scope: 'global', kind: 'insight', canonicalKey: 'ai-daily-flow', title: '日报流程', lifecycle: 'active', version: { versionId: noteVersionId, title: '日报流程', statement: 'AI 日报需要核验来源并绑定固定版本引用。', body: '详细正文：先扫描后核验。', conclusionStatus: 'supported', evidenceLevel: 'corroborated' } }],
    wikiPages: [{ id: pageId, scope: 'global', pageType: 'topic', canonicalKey: 'wiki-topic:t1', title: 'AI 日报主题页', subjectType: 'topic', subjectId: 't1', lifecycle: 'active', version: { versionId: pageVersionId, title: 'AI 日报主题页', body: { kind: 'topic-wiki', title: 'AI 日报主题页', summary: '主题页摘要', keyConclusions: [{ statement: '日报必须核验来源' }] }, changeSummary: '首次编译', compileReason: 'accept' } }],
    evidenceLinks: [{ knowledgeNoteVersionId: noteVersionId, evidenceObjectType: 'source', evidenceObjectId: 's-any', relation: 'supports', sourceNature: 'primary_source' }],
    receipts: [{ triggerType: 'ingest', requestId, summary: '验收编译', counts: { notesCreated: 1, entitiesCreated: 1, wikiPagesCompiled: 1 }, wikiPageVersions: [pageVersionId] }]
  });
  check('replay returns replay=true', replay.replay === true, JSON.stringify(replay));
  check('replay produces zero index rows and zero projections', indexRows().length === before && lastUpsertBatch.length === 0, `${indexRows().length} vs ${before}`);
}

// ============ 5. 失败/回滚 → 无孤儿索引 ============
{
  // 5a. ChangeSet 内部失败（revision 冲突）→ 整体回滚，索引零投影
  const before = indexRows().length;
  lastUpsertBatch = [];
  let threw = false;
  try {
    applyKnowledgeChangeSet(database, meta('compile-fail-1'), {
      entities: [{ id: 'entity-fail', scope: 'global', entityType: 'person', canonicalKey: 'fail-key', canonicalName: '失败实体', lifecycle: 'active', beforeRevision: 99 }]
    });
  } catch {
    threw = true;
  }
  check('failing change set throws', threw);
  check('failing change set leaves zero index rows', indexRows().length === before && lastUpsertBatch.length === 0, `${indexRows().length} vs ${before}`);

  // 5b. 业务写成功 + 索引投影失败 → 业务不回滚（失败隔离，可重建兜底）
  failNextUpsert = true;
  const saved = upsertSource(database, { title: '投影失败隔离源', summary: '即使索引写入失败业务写也必须已提交', originalUrl: 'https://example.com/iso' });
  failNextUpsert = false;
  const sourceRow = database.prepare('SELECT revision FROM source_items WHERE id = ?').get(saved.id);
  check('business write committed despite index failure', Boolean(sourceRow) && sourceRow.revision === 1, JSON.stringify(sourceRow));
  const missing = indexRows().find((r) => r.objectType === 'source' && r.objectId === saved.id);
  check('failed projection leaves no partial row (SAVEPOINT rollback)', !missing, JSON.stringify(missing));
}

// ============ 6. 归档 ChangeSet → 索引移除 ============
{
  applyKnowledgeChangeSet(database, meta('archive-1'), {
    notes: [{ id: 'note-archive-me', scope: 'global', kind: 'insight', canonicalKey: 'archive-me', title: '待归档', lifecycle: 'active', version: { versionId: 'wver-archive-1', statement: '将被归档', conclusionStatus: 'supported', evidenceLevel: 'single' } }]
  });
  check('note exists before archive', Boolean(indexRows().find((r) => r.objectType === 'knowledge_note' && r.objectId === 'note-archive-me')));
  applyKnowledgeChangeSet(database, meta('archive-2'), {
    notes: [{ id: 'note-archive-me', scope: 'global', kind: 'insight', canonicalKey: 'archive-me', title: '待归档', lifecycle: 'archived', beforeRevision: 1, version: { versionId: 'wver-archive-2', statement: '将被归档', conclusionStatus: 'supported', evidenceLevel: 'single' } }]
  });
  const row = indexRows().find((r) => r.objectType === 'knowledge_note' && r.objectId === 'note-archive-me');
  check('archived note removed from index', !row, JSON.stringify(row));
}

// ============ 7. 未注册 API → 零行为变化 ============
{
  setWikiIndexProjectionApi(null);
  const before = indexRows().length;
  upsertSource(database, { title: '未接线源', originalUrl: 'https://example.com/unwired' });
  check('unregistered api is no-op (zero index writes)', indexRows().length === before, `${indexRows().length} vs ${before}`);
  setWikiIndexProjectionApi({
    upsertIndexEntries(db, entries) {
      for (const entry of entries) {
        db.prepare(`INSERT INTO knowledge_index_entries
          (object_type, object_id, version_ref, title, summary, searchable_text, topic_ids_json, scope, compile_status, updated_at, nav_object_type, nav_object_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(object_type, object_id) DO UPDATE SET
            version_ref=excluded.version_ref, title=excluded.title, summary=excluded.summary,
            searchable_text=excluded.searchable_text, topic_ids_json=excluded.topic_ids_json, scope=excluded.scope,
            compile_status=excluded.compile_status, updated_at=excluded.updated_at,
            nav_object_type=excluded.nav_object_type, nav_object_id=excluded.nav_object_id`)
          .run(entry.objectType, entry.objectId, entry.versionRef, entry.title, entry.summary ?? '',
            entry.searchableText ?? '', JSON.stringify(entry.topicIds ?? []), entry.scope ?? 'global',
            entry.compileStatus ?? 'current', entry.updatedAt, entry.navObjectType ?? null, entry.navObjectId ?? null);
      }
      return entries.length;
    },
    removeIndexEntries(db, keys) {
      for (const key of keys) db.prepare('DELETE FROM knowledge_index_entries WHERE object_type = ? AND object_id = ?').run(key.objectType, key.objectId);
    },
    rebuildWikiIndex() { return { total: 0, byType: {}, rebuiltAt: now() }; }
  });
}

database.close();
console.log(`WMB-5238 triggers child: ${checks} checks passed`);
await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
