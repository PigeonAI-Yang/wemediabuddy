/**
 * WMB-5238 索引存储核心验收（子进程，真实 SQLite）。
 * 覆盖：
 * - fresh 库 migrateDatabase 全链（含 migration 63 wiki 索引表，当前最大为生产 migrations 最高版本）成功；重复 migrateDatabase 幂等；
 * - rebuildWikiIndex 从业务表重建：wiki_page（含全部版本 fvr）、knowledge_note、entity、
 *   topic、source（含 source_body_revisions fvr）计数与版本锚逐项命中；
 * - 同对象新版本不抹除历史固定引用：upsert 新版本后旧版本 fvr 行与业务版本表均保留；
 * - upsertIndexEntries/removeIndexEntries 原子性（失败零写）与幂等；
 * - listIndexEntries 稳定排序 + 有界分页信封；getIndexSummary 计数；
 * - knowledge_hot_cache 单行有界、可重建、可读取；
 * - installWorkspaceWriteGuard 对迁移 63 新表自动生效（未授权写被拒，授权写通过）。
 * 退出码 0 = 全部通过；任何断言失败抛错并以非 0 退出。
 */
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations, migrateDatabase } from '../src/main/db/migrations.ts';
import {
  upsertIndexEntries, removeIndexEntries, rebuildWikiIndex, listIndexEntries,
  getIndexSummary, refreshWikiHotCache, rebuildWikiHotCache, getWikiHotCache
} from '../src/main/db/wiki-index-store.ts';
import { installWorkspaceWriteGuard } from '../src/main/db/write-guard.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-5238-idx-'));
const databasePath = path.join(directory, 'wmb.db');

let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) throw new Error(`FAIL [${checks}] ${label}${detail ? ` — ${detail}` : ''}`);
}
async function expectError(label, fn, code) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    if (code && String(error?.message ?? error).includes(code)) return;
    throw new Error(`FAIL [${checks}] ${label} — 期望错误 ${code}，实际 ${error?.message ?? error}`);
  }
  throw new Error(`FAIL [${checks}] ${label} — 期望抛错 ${code}，但未抛出`);
}

// ============================================================
// 1) fresh 迁移 + 重复迁移
// ============================================================
let database = migrateDatabase(databasePath);
const schema = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('knowledge_index_entries','knowledge_hot_cache')").all();
check('migration 63 建表', schema.length === 2, JSON.stringify(schema));
const applied = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(({ version }) => Number(version));
const maxVersion = Math.max(...migrations.map((m) => m.version));
check('schema_migrations 含 63', applied.includes(63), JSON.stringify(applied));
check(`迁移版本精确连续 1..${maxVersion}`, applied.length === maxVersion && applied.length === migrations.length && applied.every((version, index) => version === index + 1), JSON.stringify(applied));
// 重复迁移（重新打开）幂等
database.close();
database = migrateDatabase(databasePath);
const appliedAgain = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(({ version }) => Number(version));
check(`重复迁移幂等（1..${maxVersion} 各恰一次）`, appliedAgain.length === maxVersion && appliedAgain.length === migrations.length && appliedAgain.every((version, index) => version === index + 1), JSON.stringify(appliedAgain));

// ============================================================
// 2) 业务表种子数据
// ============================================================
const now = new Date().toISOString();
const changeSetId = 'cs:1';
database.prepare(`INSERT INTO knowledge_change_sets
  (id, workspace_id, request_id, input_hash, reason, trigger_source, resolution_mode, created_by, created_at)
  VALUES (?, 'ws:1', 'req:1', 'h', 'seed', 'creation', 'none', 'user', ?)`).run(changeSetId, now);

// ---- wiki page + 2 versions ----
const pageId = 'page:1';
database.prepare(`INSERT INTO knowledge_wiki_pages
  (id, scope, page_type, canonical_key, title, subject_type, subject_id, lifecycle, compile_status, revision, created_at, updated_at)
  VALUES (?, 'global', 'topic', 'topic-a', 'Topic A Wiki', 'topic', 'topic:1', 'active', 'current', 2, ?, ?)`).run(pageId, now, now);
const wikiVersionIds = ['wv:1', 'wv:2'];
database.prepare(`INSERT INTO knowledge_wiki_page_versions
  (id, page_id, version_number, title, body_json, adopted_note_version_ids_json, business_object_refs_json,
   flags_json, change_summary, readable_diff, compile_reason, creator_nature, change_set_id, created_at)
  VALUES (?, ?, 1, 'Topic A Wiki v1', ?, '[]', '[]', '[]', 'create', '', 'seed', 'user', ?, ?)`).run(wikiVersionIds[0], pageId, JSON.stringify({ sections: [{ heading: '判断', body: '第一版综合：英国租房材料优先验证收入证明。' }] }), changeSetId, now);
database.prepare(`INSERT INTO knowledge_wiki_page_versions
  (id, page_id, version_number, title, body_json, adopted_note_version_ids_json, business_object_refs_json,
   flags_json, change_summary, readable_diff, compile_reason, creator_nature, change_set_id, created_at)
  VALUES (?, ?, 2, 'Topic A Wiki v2', ?, '[]', '[]', '[]', 'strengthen', '', 'seed', 'user', ?, ?)`).run(wikiVersionIds[1], pageId, JSON.stringify({ sections: [{ heading: '判断', body: '第二版综合：收入证明之外还需银行流水佐证。' }] }), changeSetId, now);
database.prepare('UPDATE knowledge_wiki_pages SET current_version_id = ? WHERE id = ?').run(wikiVersionIds[1], pageId);

// ---- knowledge note + 2 versions ----
const noteId = 'note:1';
database.prepare(`INSERT INTO knowledge_notes
  (id, scope, kind, canonical_key, title, lifecycle, revision, created_at, updated_at)
  VALUES (?, 'global', 'claim', 'rent-income-proof', '收入证明是核心', 'active', 2, ?, ?)`).run(noteId, now, now);
const noteVersionIds = ['nv:1', 'nv:2'];
database.prepare(`INSERT INTO knowledge_note_versions
  (id, note_id, version_number, title, statement, body, conclusion_status, evidence_level, applies_to,
   adopted_entity_ids_json, adopted_topic_ids_json, adopted_knowledge_version_ids_json, change_type,
   change_reason, creator_nature, change_set_id, created_at)
  VALUES (?, ?, 1, '收入证明是核心', '房东要求收入证明', '第一版：收入证明是英国租房核心材料。', 'supported', 'single', '',
   '[]', '["topic:1"]', '[]', 'created', '', 'user', ?, ?)`).run(noteVersionIds[0], noteId, changeSetId, now);
database.prepare(`INSERT INTO knowledge_note_versions
  (id, note_id, version_number, title, statement, body, conclusion_status, evidence_level, applies_to,
   adopted_entity_ids_json, adopted_topic_ids_json, adopted_knowledge_version_ids_json, change_type,
   change_reason, creator_nature, change_set_id, created_at)
  VALUES (?, ?, 2, '收入证明是核心', '收入证明需银行流水佐证', '第二版：收入证明之外还需银行流水佐证。', 'supported', 'corroborated', '',
   '[]', '["topic:1"]', '[]', 'strengthened', '', 'user', ?, ?)`).run(noteVersionIds[1], noteId, changeSetId, now);
database.prepare('UPDATE knowledge_notes SET current_version_id = ? WHERE id = ?').run(noteVersionIds[1], noteId);

// ---- entity ----
const entityId = 'entity:1';
database.prepare(`INSERT INTO knowledge_entities
  (id, scope, entity_type, canonical_key, canonical_name, aliases_json, external_identity_json, lifecycle, revision, created_at, updated_at)
  VALUES (?, 'global', 'organization', 'ukvi', 'UKVI', '["英国签证移民局"]', '{}', 'active', 3, ?, ?)`).run(entityId, now, now);

// ---- topic ----
database.prepare(`INSERT INTO topics
  (id, title, canonical_key, kind, summary, status, first_seen_at, last_seen_at, created_at, updated_at, revision)
  VALUES ('topic:1', '英国租房', 'uk-rental', 'theme', '英国租房材料与流程', 'active', ?, ?, ?, ?, 1)`).run(now, now, now, now);

// ---- source + body revision ----
database.prepare(`INSERT INTO source_items
  (id, original_url, canonical_url, title, collected_at, categories_json, keywords_json,
   recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision,
   verification_status, management_status)
  VALUES ('source:1', 'https://example.com/rent', 'https://example.com/rent', '英国租房担保人指南',
   ?, '["租房"]', '["guarantor","担保人"]', '["x","xiaohongshu"]', '["list","article"]', ?, ?, 5, 'verified', 'active')`).run(now, now, now);
const sourceRevisionId = 'sbr:1';
database.prepare(`INSERT INTO source_body_revisions
  (id, source_id, url, status, content_type, extracted_text, extracted_chars, body_hash, error_message, fetched_at, created_at, previous_revision_id)
  VALUES (?, 'source:1', 'https://example.com/rent', 'ready', 'text/plain', '英国租房担保人指南全文：担保人需提供收入证明与身份文件。', 34, ?, NULL, ?, ?, NULL)`).run(sourceRevisionId, 'a'.repeat(64), now, now);
database.prepare(`INSERT INTO topic_source_links (topic_id, source_id, relation, created_at, updated_at)
  VALUES ('topic:1', 'source:1', 'primary', ?, ?)`).run(now, now);

// ============================================================
// 3) rebuildWikiIndex：业务表 → 索引
// ============================================================
const rebuilt = rebuildWikiIndex(database);
check('rebuild 计数 wiki_page=1', rebuilt.byType.wiki_page === 1, JSON.stringify(rebuilt.byType));
check('rebuild 计数 knowledge_note=1', rebuilt.byType.knowledge_note === 1, JSON.stringify(rebuilt.byType));
check('rebuild 计数 entity=1', rebuilt.byType.entity === 1, JSON.stringify(rebuilt.byType));
check('rebuild 计数 topic=1', rebuilt.byType.topic === 1, JSON.stringify(rebuilt.byType));
check('rebuild 计数 source=1', rebuilt.byType.source === 1, JSON.stringify(rebuilt.byType));
// fvr = 2 wiki 版本 + 2 note 版本 + 1 source 正文版本
check('rebuild 计数 fixed_version_reference=5', rebuilt.byType.fixed_version_reference === 5, JSON.stringify(rebuilt.byType));
check('rebuild 总量=10', rebuilt.total === 10, String(rebuilt.total));

const pageRow = database.prepare(`SELECT version_ref AS versionRef, title, searchable_text AS searchableText, scope, compile_status AS compileStatus, nav_object_type AS navObjectType, nav_object_id AS navObjectId FROM knowledge_index_entries WHERE object_type='wiki_page' AND object_id=?`).get(pageId);
check('wiki_page 当前行版本锚=wv:2', pageRow?.versionRef === 'wv:2', JSON.stringify(pageRow));
check('wiki_page 当前行标题=Topic A Wiki v2', pageRow?.title === 'Topic A Wiki v2', String(pageRow?.title));
check('wiki_page 正文入 searchable', String(pageRow?.searchableText).includes('银行流水'), String(pageRow?.searchableText));
check('wiki_page scope/compile_status 投影', pageRow?.scope === 'global' && pageRow?.compileStatus === 'current', JSON.stringify(pageRow));
check('wiki_page nav 指向主体 topic', pageRow?.navObjectType === 'topic' && pageRow?.navObjectId === 'topic:1', JSON.stringify(pageRow));

const fvrWiki = database.prepare(`SELECT object_id AS objectId, version_ref AS versionRef, title FROM knowledge_index_entries WHERE object_type='fixed_version_reference' AND nav_object_type='wiki_page' ORDER BY object_id`).all();
check('wiki fvr 两版本均在', fvrWiki.length === 2 && fvrWiki.every((row) => row.versionRef === row.objectId), JSON.stringify(fvrWiki));
check('wiki fvr 含 v1 历史版本', fvrWiki.some((row) => row.objectId === 'wv:1'), JSON.stringify(fvrWiki));

const noteRow = database.prepare(`SELECT version_ref AS versionRef, title, summary, searchable_text AS searchableText, topic_ids_json AS topicIdsJson FROM knowledge_index_entries WHERE object_type='knowledge_note' AND object_id=?`).get(noteId);
check('note 当前行版本锚=nv:2', noteRow?.versionRef === 'nv:2', JSON.stringify(noteRow));
check('note topic_ids 来自当前版本 adopted_topic_ids_json', JSON.parse(noteRow?.topicIdsJson ?? '[]').includes('topic:1'), JSON.stringify(noteRow));

const entityRow = database.prepare(`SELECT version_ref AS versionRef, title, searchable_text AS searchableText FROM knowledge_index_entries WHERE object_type='entity' AND object_id=?`).get(entityId);
check('entity 版本锚=rev:3', entityRow?.versionRef === 'rev:3', JSON.stringify(entityRow));
check('entity aliases 入 searchable', String(entityRow?.searchableText).includes('英国签证移民局'), String(entityRow?.searchableText));

const topicRow = database.prepare(`SELECT version_ref AS versionRef, title, topic_ids_json AS topicIdsJson FROM knowledge_index_entries WHERE object_type='topic' AND object_id='topic:1'`).get();
check('topic 版本锚=rev:1', topicRow?.versionRef === 'rev:1', JSON.stringify(topicRow));
check('topic topic_ids 含自身', JSON.parse(topicRow?.topicIdsJson ?? '[]').includes('topic:1'), JSON.stringify(topicRow));

const sourceRow = database.prepare(`SELECT version_ref AS versionRef, title, searchable_text AS searchableText, topic_ids_json AS topicIdsJson FROM knowledge_index_entries WHERE object_type='source' AND object_id='source:1'`).get();
check('source 版本锚=最新 source_body_revision id', sourceRow?.versionRef === sourceRevisionId, JSON.stringify(sourceRow));
check('source 正文入 searchable', String(sourceRow?.searchableText).includes('担保人需提供收入证明'), String(sourceRow?.searchableText));
check('source topic_ids 来自 topic_source_links', JSON.parse(sourceRow?.topicIdsJson ?? '[]').includes('topic:1'), JSON.stringify(sourceRow));

const sourceFvr = database.prepare(`SELECT object_id AS objectId, nav_object_id AS navObjectId FROM knowledge_index_entries WHERE object_type='fixed_version_reference' AND nav_object_type='source'`).all();
check('source fvr 指向父对象', sourceFvr.length === 1 && sourceFvr[0].navObjectId === 'source:1', JSON.stringify(sourceFvr));

// ============================================================
// 4) 同对象新版本不抹除历史固定引用（upsert 语义）
// ============================================================
const newWikiVersionId = 'wv:3';
const now2 = new Date(Date.now() + 1000).toISOString();
const beforeUpsert = database.prepare(`SELECT count(*) AS count FROM knowledge_index_entries WHERE object_type='fixed_version_reference' AND nav_object_type='wiki_page'`).get().count;
upsertIndexEntries(database, [
  {
    objectType: 'wiki_page',
    objectId: pageId,
    versionRef: newWikiVersionId,
    title: 'Topic A Wiki v3',
    summary: '',
    searchableText: '第三版综合：担保人材料升级。',
    topicIds: ['topic:1'],
    scope: 'global',
    compileStatus: 'current',
    updatedAt: now2,
    navObjectType: 'wiki_page',
    navObjectId: pageId
  },
  {
    objectType: 'fixed_version_reference',
    objectId: newWikiVersionId,
    versionRef: newWikiVersionId,
    title: 'Topic A Wiki v3',
    summary: '',
    searchableText: '第三版综合：担保人材料升级。',
    topicIds: ['topic:1'],
    scope: 'global',
    compileStatus: 'current',
    updatedAt: now2,
    navObjectType: 'wiki_page',
    navObjectId: pageId
  }
]);
const afterUpsert = database.prepare(`SELECT count(*) AS count FROM knowledge_index_entries WHERE object_type='fixed_version_reference' AND nav_object_type='wiki_page'`).get().count;
check('upsert 追加新 fvr 行，旧 fvr 行保留', Number(afterUpsert) === Number(beforeUpsert) + 1, `${beforeUpsert} → ${afterUpsert}`);
const oldFvr = database.prepare(`SELECT 1 FROM knowledge_index_entries WHERE object_type='fixed_version_reference' AND object_id='wv:1'`).get();
check('wv:1 历史 fvr 仍可解析', Boolean(oldFvr));
const currentAfter = database.prepare(`SELECT version_ref AS versionRef FROM knowledge_index_entries WHERE object_type='wiki_page' AND object_id=?`).get(pageId);
check('upsert 移动当前投影版本锚到新版本', currentAfter?.versionRef === newWikiVersionId, JSON.stringify(currentAfter));
const businessVersion = database.prepare(`SELECT count(*) AS count FROM knowledge_wiki_page_versions WHERE page_id=?`).get(pageId);
check('业务版本表未受影响（wv:1/wv:2 保留）', Number(businessVersion.count) === 2, JSON.stringify(businessVersion));

// 幂等：同 entry 重放零变化
const beforeIdempotent = database.prepare(`SELECT count(*) AS count FROM knowledge_index_entries`).get().count;
upsertIndexEntries(database, [
  {
    objectType: 'wiki_page', objectId: pageId, versionRef: newWikiVersionId, title: 'Topic A Wiki v3',
    summary: '', searchableText: '第三版综合：担保人材料升级。', topicIds: ['topic:1'], scope: 'global',
    compileStatus: 'current', updatedAt: now2, navObjectType: 'wiki_page', navObjectId: pageId
  }
]);
const afterIdempotent = database.prepare(`SELECT count(*) AS count FROM knowledge_index_entries`).get().count;
check('upsert 幂等（重放不新增行）', Number(afterIdempotent) === Number(beforeIdempotent), `${beforeIdempotent} → ${afterIdempotent}`);

// ============================================================
// 5) removeIndexEntries
// ============================================================
removeIndexEntries(database, [{ objectType: 'fixed_version_reference', objectId: newWikiVersionId }]);
const removed = database.prepare(`SELECT 1 FROM knowledge_index_entries WHERE object_type='fixed_version_reference' AND object_id=?`).get(newWikiVersionId);
check('remove 删除指定行', !removed);
const stillThere = database.prepare(`SELECT 1 FROM knowledge_index_entries WHERE object_type='wiki_page' AND object_id=?`).get(pageId);
check('remove 不影响其他行', Boolean(stillThere));

// ============================================================
// 6) listIndexEntries / getIndexSummary
// ============================================================
const listAll = listIndexEntries(database, { limit: 3, offset: 0 });
check('list 信封 {items,total,limit,offset,hasMore}', 'items' in listAll && 'total' in listAll && 'hasMore' in listAll && listAll.limit === 3 && listAll.offset === 0, JSON.stringify(listAll));
check('list items ≤ limit', listAll.items.length === 3, String(listAll.items.length));
check('list hasMore 为 true（总数>3）', listAll.hasMore === true, JSON.stringify({ total: listAll.total }));
check('list 稳定排序 updated_at DESC', listAll.items[0].updatedAt >= listAll.items[1].updatedAt, JSON.stringify(listAll.items.map((item) => item.updatedAt)));
const listTopic = listIndexEntries(database, { objectType: 'topic', limit: 10 });
check('list objectType 过滤', listTopic.total === 1 && listTopic.items[0].objectId === 'topic:1', JSON.stringify(listTopic));
const listSearch = listIndexEntries(database, { query: '担保人', limit: 10 });
check('list 全文命中（担保人）', listSearch.total >= 2, JSON.stringify(listSearch.items.map((item) => [item.objectType, item.title])));
const summary = getIndexSummary(database);
check('summary 总量与计数一致', summary.total === listAll.total && summary.counts.topic === 1, JSON.stringify(summary));

// ============================================================
// 7) knowledge_hot_cache 单行有界
// ============================================================
check('hot cache 初始为 null', getWikiHotCache(database) === null);
refreshWikiHotCache(database, JSON.stringify({ hello: 'world' }));
const hotRow = getWikiHotCache(database);
check('hot cache 写入后可读', hotRow !== null && JSON.parse(hotRow.payloadJson).hello === 'world' && typeof hotRow.rebuiltAt === 'string', JSON.stringify(hotRow));
refreshWikiHotCache(database, JSON.stringify({ hello: 'again' }));
const hotRow2 = getWikiHotCache(database);
check('hot cache 单行覆盖（id=1 唯一）', hotRow2 !== null && JSON.parse(hotRow2.payloadJson).hello === 'again', JSON.stringify(hotRow2));
const hotCount = database.prepare('SELECT count(*) AS count FROM knowledge_hot_cache').get().count;
check('hot cache 恰一行', Number(hotCount) === 1, String(hotCount));
const rebuiltPayload = rebuildWikiHotCache(database);
const parsedPayload = JSON.parse(rebuiltPayload);
check('rebuildWikiHotCache 含 summary+recent', Boolean(parsedPayload.summary) && Array.isArray(parsedPayload.recent) && parsedPayload.recent.length <= 500, rebuiltPayload.slice(0, 200));
const hotRow3 = getWikiHotCache(database);
check('rebuild 后 hot cache 可读', hotRow3 !== null && JSON.parse(hotRow3.payloadJson).summary.total > 0, hotRow3?.payloadJson?.slice(0, 120));

// ============================================================
// 8) write guard 对迁移 63 新表自动生效
// ============================================================
const guardedDb = new DatabaseSync(databasePath);
try {
  installWorkspaceWriteGuard(guardedDb, () => false);
  expectError('未授权写被 guard 拒绝', () => {
    guardedDb.prepare(`INSERT INTO knowledge_index_entries
      (object_type, object_id, version_ref, title, updated_at) VALUES ('topic','g:1','rev:1','x','2000-01-01T00:00:00.000Z')`).run();
  }, 'WMB_WRITE_REQUIRES_COMMAND_DISPATCH');
  expectError('未授权 hot cache 写被 guard 拒绝', () => {
    guardedDb.prepare(`INSERT INTO knowledge_hot_cache (id, payload_json, rebuilt_at) VALUES (1, '{}', '2000-01-01T00:00:00.000Z')`).run();
  }, 'WMB_WRITE_REQUIRES_COMMAND_DISPATCH');
} finally {
  guardedDb.close();
}
const authorizedDb = new DatabaseSync(databasePath);
try {
  installWorkspaceWriteGuard(authorizedDb, () => true);
  authorizedDb.prepare(`INSERT INTO knowledge_index_entries
    (object_type, object_id, version_ref, title, updated_at) VALUES ('topic','g:2','rev:1','guard-ok','2000-01-01T00:00:00.000Z')`).run();
  check('授权窗口内写通过', true);
} finally {
  authorizedDb.close();
}

// 收尾：主连接重建回到干净基线（g:2 测试行移除）
removeIndexEntries(database, [{ objectType: 'topic', objectId: 'g:2' }]);
check('清理测试行', !database.prepare(`SELECT 1 FROM knowledge_index_entries WHERE object_id='g:2'`).get());

database.close();
console.log(`WMB-5238 index store core: ${checks} checks PASS`);
process.exit(0);
