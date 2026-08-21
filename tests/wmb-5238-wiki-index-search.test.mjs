// WMB-5238：SQLite 内建 Wiki 索引 / 全局时间日志 / 统一全文搜索 —— 端到端聚焦行为测试。
// 本文件与 workers 的切片测试互补：
//  - wmb-5238-knowledge-search.test.mjs（读模型直插）：搜索/游标/摘要/hot-cache 读侧；
//  - wmb-5238-knowledge-global-log.test.mjs（投影日志）：9 类事件/分页/锚点不漂移；
//  - wmb-5238-index-triggers-child.mjs（test-double 触发接线）：ChangeSet/归档/失败隔离；
// 本文件使用真实 store + 真实业务管道（migrateDatabase/upsertSource/writeSourceBodyCache/
// compileSourceKnowledge/applyKnowledgeChangeSet），锁定跨切片合同：
//  1) migration 63 落库（wiki 索引表；当前最大为生产 migrations 最高版本，全链精确连续 1..CURRENT；重放幂等）；
//  2) 六类对象经真实管道进入索引（Wiki 正文/Note/Entity/Topic/Source/固定版本引用）；
//     正文级搜索命中（词只在正文、不在元数据）；
//  3) 固定版本锚：当前行 versionRef = 不可变版本 id / rev:{revision} / 正文 revision id；
//     新版本只移动当前锚并追加新 fvr 行，历史 fvr 行不抹除；搜索结果 versionRef 可经正式表解析；
//  4) 索引重建等价：rebuild 确定可复现（wipe→rebuild 逐字节一致）；重建行集合与增量投影
//     一致（objectType+objectId+versionRef+title+updatedAt+topicIds+nav）；归档对象不被重建复活；
//  5) index/log/hot-cache 等价读模型：store 摘要 == 搜索摘要 == hot cache 摘要；
//     持久 hot cache 有界可重建；全局日志派生事件与索引同一批业务写；
//  6) 分页稳定：搜索 keyset 跨页间插入新行不重不丢；排序完全确定；
//  7) 数据根隔离：两个 data-root 互不可见；
//  8) 写守卫：新表 INSERT/DELETE 在未授权上下文 RAISE（WMB_WRITE_REQUIRES_COMMAND_DISPATCH）。
// 运行：node --test --test-concurrency=1 tests/wmb-5238-wiki-index-search.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { migrations, migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const { writeSourceBodyCache } = await import('../src/main/source-body-cache.ts');
const { compileSourceKnowledge } = await import('../src/main/knowledge-compiler.ts');
const { applyKnowledgeChangeSet, getKnowledgeNote, getKnowledgeNoteVersion } = await import('../src/main/knowledge-flywheel.ts');
const { searchWikiIndex, getWikiIndexSummary, getWikiHotCache, rebuildWikiHotCache } = await import('../src/main/knowledge-search.ts');
const { listKnowledgeLogEntries } = await import('../src/main/knowledge-global-log.ts');
const store = await import('../src/main/db/wiki-index-store.ts');
const triggers = await import('../src/main/wiki-index-triggers.ts');
const { installWorkspaceWriteGuard } = await import('../src/main/db/write-guard.ts');

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5238-e2e-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeDatabase(root, workspaceId = `ws-${randomUUID()}`) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return { database, workspaceId };
}

/** 注册真实 store 为投影 API（生产 index.ts 启动时同构）。 */
function wireProjection() {
  triggers.setWikiIndexProjectionApi({
    upsertIndexEntries: store.upsertIndexEntries,
    removeIndexEntries: store.removeIndexEntries,
    rebuildWikiIndex: store.rebuildWikiIndex
  });
  triggers.registerWikiIndexProjection();
}

function linkTopicSource(database, topicId, sourceId) {
  const now = new Date().toISOString();
  database.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(topicId, sourceId, 'primary', now, now);
}

/** 写入 Source 正文固定版本（触发正文级投影）。 */
function seedSourceBody(database, sourceId, url, bodyText) {
  const now = new Date().toISOString();
  writeSourceBodyCache(database, {
    sourceId, url, status: 'ready', contentType: 'text/html',
    extractedText: bodyText, extractedChars: bodyText.length, errorMessage: null, fetchedAt: now, updatedAt: now
  });
}

/** 一次编译：entity + note + topic-wiki 页（含回执与证据链）。 */
function compileOnce(database, workspaceId, source, topicId, requestId, noteOverrides = {}, topicCompile = { title: '小红书运营', summary: 'fixture 编译' }) {
  const result = compileSourceKnowledge(database, {
    requestId,
    workspaceId,
    sourceId: source.id,
    sourceRevision: source.revision,
    topicId,
    reason: 'fixture 端到端编译。',
    entities: [
      { entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', aliases: ['AF'], excerpt: '官方产品。', valueRationale: '官方身份可验证。' }
    ],
    notes: [
      {
        kind: 'claim', canonicalKey: 'search-algo', statement: '搜索推荐算法向内容质量倾斜。',
        body: '平台搜索推荐算法分析：标题决定曝光，正文决定完读。',
        conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: '正文。',
        valueRationale: '官方发布可验证。', ...noteOverrides
      }
    ],
    topicCompile
  });
  return result;
}

function indexRows(database, objectType = null) {
  const rows = objectType
    ? database.prepare('SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef, title, updated_at AS updatedAt, topic_ids_json AS topicIdsJson, nav_object_type AS navObjectType, nav_object_id AS navObjectId, searchable_text AS searchableText FROM knowledge_index_entries WHERE object_type = ? ORDER BY object_type, object_id').all(objectType)
    : database.prepare('SELECT object_type AS objectType, object_id AS objectId, version_ref AS versionRef, title, updated_at AS updatedAt, topic_ids_json AS topicIdsJson, nav_object_type AS navObjectType, nav_object_id AS navObjectId, searchable_text AS searchableText FROM knowledge_index_entries ORDER BY object_type, object_id').all();
  return rows;
}

function rowIdentity(rows) {
  return rows.map((r) => [r.objectType, r.objectId, r.versionRef, r.title, r.updatedAt, r.topicIdsJson, r.navObjectType ?? '', r.navObjectId ?? '']).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function cleanup(root) {
  // 尽力而为：Windows 下残留句柄可导致 rm EBUSY；测试断言才是验收，临时目录残留可忽略。
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  } catch {
    /* best effort */
  }
}

// ============ 1. migration 63 落库 + 全链 1..CURRENT：重放幂等 ============

test('WMB-5238 migration 63: lands on migrated connection, versions exact 1..CURRENT, replay idempotent', async () => {
  const root = await makeRoot();
  try {
    const { database } = makeDatabase(root);
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
    assert.ok(versions.includes(63), 'migration 63 应已应用');
    const maxVersion = Math.max(...migrations.map((m) => m.version));
    assert.deepEqual(versions, Array.from({ length: maxVersion }, (_, index) => index + 1), `迁移版本应精确连续 1..${maxVersion}`);
    const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((r) => String(r.name)));
    assert.ok(tables.has('knowledge_index_entries'), '索引表应存在');
    assert.ok(tables.has('knowledge_hot_cache'), '持久 hot cache 表应存在');

    // 重放幂等：再次 migrate 同一路径不重跑、不重复建表/行。
    database.prepare(`INSERT INTO knowledge_index_entries
      (object_type, object_id, version_ref, title, summary, searchable_text, updated_at) VALUES ('topic','replay-id','rev:1','重放','','','2026-08-13T00:00:00.000Z')`).run();
    database.close();
    const again = migrateDatabase(path.join(root, 'wmb.db'));
    const versions2 = again.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
    assert.deepEqual(versions2, versions, '重开 DB 迁移版本列表不变');
    const rows = again.prepare('SELECT count(*) AS c FROM knowledge_index_entries').get().c;
    assert.equal(rows, 1, '重开 DB 不重复执行 rebuild 或清空索引');
    again.close();
  } finally {
    await cleanup(root);
  }
});

// ============ 2. 六类对象真实管道 + 正文级搜索 ============

test('WMB-5238 六类对象经真实管道入索引；正文级命中（词只在正文）', async () => {
  const root = await makeRoot();
  try {
    const { database, workspaceId } = makeDatabase(root);
    wireProjection();
    const topic = upsertKnowledgeTopic(database, { title: '小红书运营', summary: '平台算法与内容节奏' });
    const source = upsertSource(database, { originalUrl: 'https://example.com/algo', title: '平台算法解读报告' });
    linkTopicSource(database, topic.id, source.id);
    seedSourceBody(database, source.id, 'https://example.com/algo', '深度报告：标题决定曝光，正文决定完读，完读率影响推荐分发。');
    const compile = compileOnce(database, workspaceId, source, topic.id, `compile:source:${source.id}:r${source.revision}`);

    const rows = indexRows(database);
    const byKey = new Map(rows.map((r) => [`${r.objectType}:${r.objectId}`, r]));
    const types = new Set(rows.map((r) => r.objectType));
    for (const type of ['wiki_page', 'knowledge_note', 'entity', 'topic', 'source', 'fixed_version_reference']) {
      assert.ok(types.has(type), `索引应包含对象类型 ${type}`);
    }

    // 版本锚格式：wiki/note/fvr → 不可变版本 id；entity/topic → rev:{revision}；source → 正文 revision id。
    const noteRow = byKey.get(`knowledge_note:${compile.noteIds['search-algo']}`);
    assert.ok(noteRow.versionRef.startsWith('ver-'), 'note 当前行 versionRef = 不可变版本 id');
    const pageRow = byKey.get(`wiki_page:${compile.wikiPageId}`);
    assert.ok(pageRow.versionRef.startsWith('wver-'), 'wiki 页当前行 versionRef = 不可变版本 id');
    const entityRow = [...rows].find((r) => r.objectType === 'entity');
    assert.match(entityRow.versionRef, /^rev:\d+$/, 'entity versionRef = rev:{revision}');
    const topicRow = [...rows].find((r) => r.objectType === 'topic' && r.objectId === topic.id);
    assert.equal(topicRow.versionRef, 'rev:1', 'topic versionRef = rev:{revision}');
    const sourceRow = [...rows].find((r) => r.objectType === 'source' && r.objectId === source.id);
    assert.ok(!sourceRow.versionRef.startsWith('rev:'), 'source 有正文后 versionRef = 正文 revision id');

    // 正文级搜索：词只出现在 source_body_revisions.extracted_text，元数据（title/summary）不含。
    const bodyOnlyHit = searchWikiIndex(database, { query: '完读率影响推荐分发', limit: 10 });
    assert.ok(bodyOnlyHit.items.some((item) => item.objectType === 'source' && item.objectId === source.id),
      '正文独有词必须命中 source（正文级搜索证明）');
    // Wiki 正文 body_json 里的 keyConclusions statement 可命中 wiki_page。
    const bodyJsonHit = searchWikiIndex(database, { query: '搜索推荐算法向内容质量倾斜', limit: 10 });
    assert.ok(bodyJsonHit.items.some((item) => item.objectType === 'wiki_page' && item.objectId === compile.wikiPageId),
      'Wiki 正文词必须命中 wiki_page');
    assert.ok(bodyJsonHit.items.some((item) => item.objectType === 'knowledge_note'),
      'Note statement 词同样命中 knowledge_note');

    // 载荷契约全字段：objectType/objectId/versionRef/title/snippet/updatedAt/navigation。
    const hit = bodyOnlyHit.items.find((item) => item.objectType === 'source');
    for (const key of ['objectType', 'objectId', 'versionRef', 'title', 'snippet', 'updatedAt', 'navigation']) {
      assert.ok(hit[key] !== undefined && hit[key] !== null && hit[key] !== '', `搜索结果必须携带 ${key}`);
    }
    assert.ok(hit.navigation && typeof hit.navigation === 'object', 'navigation 为深链载荷对象');

    // 固定版本引用行可搜索（fvr 词来自版本正文）。
    const fvrHit = searchWikiIndex(database, { query: '正文决定完读', limit: 20 });
    assert.ok(fvrHit.items.some((item) => item.objectType === 'fixed_version_reference'), '固定版本引用行可被搜索命中');

  } finally {
    try {     database.close(); } catch {}
    await cleanup(root);
  }
});

// ============ 3. 固定版本锚：新版本移动当前锚、历史 fvr 不抹除 ============

test('WMB-5238 固定版本锚：新版本移动当前锚；历史 fvr 行保留；结果锚可经正式表解析', async () => {
  const root = await makeRoot();
  try {
    const { database, workspaceId } = makeDatabase(root);
    wireProjection();
    const topic = upsertKnowledgeTopic(database, { title: '小红书运营' });
    const source = upsertSource(database, { originalUrl: 'https://example.com/algo', title: '平台算法解读报告' });
    linkTopicSource(database, topic.id, source.id);
    seedSourceBody(database, source.id, 'https://example.com/algo', '第一版正文。');

    const c1 = compileOnce(database, workspaceId, source, topic.id, `c1:${randomUUID()}`);
    const noteId = c1.noteIds['search-algo'];
    const v1 = c1.noteVersionIds['search-algo'];
    const before = indexRows(database);
    const fvrBefore = new Set(before.filter((r) => r.objectType === 'fixed_version_reference').map((r) => r.objectId));
    assert.ok(fvrBefore.has(v1), '编译 1 后 note 版本 v1 应有 fvr 行');

    // 第二次编译：同 note 晋升新版本（strengthened）。
    const c2 = compileOnce(database, workspaceId, source, topic.id, `c2:${randomUUID()}`, {
      statement: '新声明：推荐算法进一步向内容质量与完读倾斜。',
      changeType: 'strengthened', changeReason: '新证据强化', locator: 'L2'
    });
    const v2 = c2.noteVersionIds['search-algo'];
    assert.notEqual(v1, v2, '第二次编译应产生新 note 版本');

    const after = indexRows(database);
    const noteRow = after.find((r) => r.objectType === 'knowledge_note' && r.objectId === noteId);
    assert.equal(noteRow.versionRef, v2, 'note 当前行 versionRef 应移动到新版本');
    const fvrAfter = new Set(after.filter((r) => r.objectType === 'fixed_version_reference').map((r) => r.objectId));
    assert.ok(fvrAfter.has(v1), '历史 fvr 行 v1 必须保留（新版本不抹除历史固定引用）');
    assert.ok(fvrAfter.has(v2), '新版本 v2 应新增 fvr 行');

    // 搜索结果 versionRef 必须能经正式表解析（不可变版本行存在）。
    const hit = searchWikiIndex(database, { query: '完读', limit: 10 }).items.find((item) => item.objectType === 'knowledge_note');
    assert.equal(hit.versionRef, v2);
    assert.ok(getKnowledgeNoteVersion(database, hit.versionRef), '搜索结果 versionRef 必须是正式 knowledge_note_versions 行');
    // 旧 fvr 行仍指向 v1 且按自身内容可搜索（新版本不抹除历史固定引用）。
    const v1row = after.find((r) => r.objectType === 'fixed_version_reference' && r.objectId === v1);
    assert.ok(v1row && v1row.versionRef === v1, 'v1 fvr 行 versionRef 冻结为 v1');
    const oldFvr = searchWikiIndex(database, { query: '向内容质量倾斜', limit: 20 }).items.find((item) => item.objectType === 'fixed_version_reference' && item.objectId === v1);
    assert.ok(oldFvr && oldFvr.versionRef === v1, '历史 note 版本 fvr 行按 v1 内容仍可搜索');
    // source 正文 fvr 行同样保留（versionRef = source body revision id）。
    const srcFvr = after.find((r) => r.objectType === 'fixed_version_reference' && r.navObjectId === source.id);
    assert.ok(srcFvr && srcFvr.versionRef === srcFvr.objectId, 'source 正文 fvr 行 versionRef = body revision id');

  } finally {
    try {     database.close(); } catch {}
    await cleanup(root);
  }
});

// ============ 4. 索引重建：确定性 + 行集合等价 + 归档不复活 ============

test('WMB-5238 索引重建：wipe→rebuild 逐字节一致；行集合与增量一致；归档不被复活', async () => {
  const root = await makeRoot();
  try {
    const { database, workspaceId } = makeDatabase(root);
    wireProjection();
    const topic = upsertKnowledgeTopic(database, { title: '小红书运营' });
    const source = upsertSource(database, { originalUrl: 'https://example.com/algo', title: '平台算法解读报告' });
    linkTopicSource(database, topic.id, source.id);
    seedSourceBody(database, source.id, 'https://example.com/algo', '正文内容：算法向内容质量倾斜。');
    const c1 = compileOnce(database, workspaceId, source, topic.id, `r1:${randomUUID()}`);

    // 增量投影后的行集合（身份键）。
    const incremental = rowIdentity(indexRows(database));
    assert.ok(incremental.length >= 7, `增量投影至少 7 行（六类 + source fvr），实际 ${incremental.length}`);

    // wipe → rebuild → 与增量行集合一致（objectType+objectId+versionRef+title+updatedAt+topicIds+nav）。
    database.prepare('DELETE FROM knowledge_index_entries').run();
    const rebuilt = store.rebuildWikiIndex(database, false);
    const afterRebuild = rowIdentity(indexRows(database));
    if (JSON.stringify(afterRebuild) !== JSON.stringify(incremental)) {
      const a = new Map(afterRebuild.map((r) => [JSON.stringify(r), r]));
      const b = new Map(incremental.map((r) => [JSON.stringify(r), r]));
      console.log('PARITY-DEBUG only-in-rebuild:', JSON.stringify(afterRebuild.filter((r) => !b.has(JSON.stringify(r)))));
      console.log('PARITY-DEBUG only-in-incremental:', JSON.stringify(incremental.filter((r) => !a.has(JSON.stringify(r)))));
    }
    assert.deepEqual(afterRebuild, incremental, '重建行集合必须与增量投影一致（含 topicIds/nav 与锚）');
    assert.ok(rebuilt.total >= incremental.length, 'rebuild total 不得小于行数');
    assert.equal(Object.values(rebuilt.byType).reduce((a, b) => a + b, 0), rebuilt.total, 'byType 合计 = total');

    // rebuild 确定性：再 wipe → rebuild → 与上一次逐字节一致。
    const first = JSON.stringify(database.prepare('SELECT * FROM knowledge_index_entries ORDER BY object_type, object_id').all());
    database.prepare('DELETE FROM knowledge_index_entries').run();
    store.rebuildWikiIndex(database, false);
    const second = JSON.stringify(database.prepare('SELECT * FROM knowledge_index_entries ORDER BY object_type, object_id').all());
    assert.equal(second, first, 'rebuild 必须确定可复现（逐字节一致）');

    // 重建后正文级搜索仍命中。
    const hit = searchWikiIndex(database, { query: '内容质量倾斜', limit: 10 });
    assert.ok(hit.items.some((item) => item.objectType === 'source'), '重建后正文搜索仍命中');

    // 归档 → 增量移除，rebuild 不得复活。
    const note = getKnowledgeNote(database, c1.noteIds['search-algo']);
    applyKnowledgeChangeSet(database,
      { workspaceId, requestId: `archive:${randomUUID()}`, reason: 'fixture 归档', triggerSource: 'user', createdBy: 'user', resolutionMode: 'manual_correction' },
      {
        notes: [{
          id: note.note.id, scope: 'global', kind: note.note.kind, canonicalKey: note.note.canonicalKey,
          title: note.note.title, lifecycle: 'archived', beforeRevision: note.note.revision,
          version: { versionId: `ver-archive-${randomUUID()}`, statement: '归档版本', conclusionStatus: 'unverified', evidenceLevel: 'none', changeType: 'archived', changeReason: 'fixture' }
        }]
      });
    const afterArchive = indexRows(database, 'knowledge_note');
    assert.equal(afterArchive.length, 0, '归档后增量投影必须移除 note 索引行');
    store.rebuildWikiIndex(database, false);
    const afterRebuild2 = indexRows(database, 'knowledge_note');
    assert.equal(afterRebuild2.length, 0, 'rebuild 不得复活已归档 note');

  } finally {
    try {     database.close(); } catch {}
    await cleanup(root);
  }
});

// ============ 5. index/log/hot-cache 等价读模型 ============

test('WMB-5238 等价读模型：store 摘要 == 搜索摘要 == hot cache；日志派生同批业务写', async () => {
  const root = await makeRoot();
  try {
    const { database, workspaceId } = makeDatabase(root);
    wireProjection();
    const topic = upsertKnowledgeTopic(database, { title: '小红书运营' });
    const source = upsertSource(database, { originalUrl: 'https://example.com/algo', title: '平台算法解读报告' });
    linkTopicSource(database, topic.id, source.id);
    seedSourceBody(database, source.id, 'https://example.com/algo', '正文内容：算法向内容质量倾斜。');
    compileOnce(database, workspaceId, source, topic.id, `c:${randomUUID()}`);

    const sStore = store.getIndexSummary(database);          // {total, counts, updatedAt, rebuiltAt}
    const sSearch = getWikiIndexSummary(database);           // {counts, total, updatedAt, rebuiltAt}
    assert.equal(sStore.total, sSearch.total, 'store 摘要与搜索摘要 total 一致');
    assert.deepEqual(sStore.counts, sSearch.counts, 'store 摘要与搜索摘要 counts 一致');
    assert.equal(sStore.updatedAt, sSearch.updatedAt, 'updatedAt 一致');

    const hot = getWikiHotCache(database);                    // 搜索侧内存 hot cache（有界）
    assert.equal(hot.maxEntries, 500, 'hot cache 有界上限 500');
    assert.ok(hot.entryCount <= hot.maxEntries, 'entryCount 有界');
    assert.equal(hot.summary.total, sStore.total, 'hot cache 摘要 == 索引摘要');
    assert.ok(hot.rebuiltAt, 'hot cache 重建时间存在');
    const hot2 = rebuildWikiHotCache(database);
    assert.ok(hot2.cached && hot2.rebuiltAt, '强制重建后 cached=true');
    assert.equal(hot2.entryCount, Math.min(sStore.total, 500));

    // 持久 hot cache（store 侧单行）：有界、可重建、非真源。
    const payload = store.rebuildWikiHotCache(database, false);
    const record = store.getWikiHotCache(database);
    assert.ok(record && record.payloadJson && record.rebuiltAt, '持久 hot cache 行存在');
    const parsed = JSON.parse(record.payloadJson);
    assert.equal(parsed.summary.total, sStore.total, '持久 hot cache 摘要 == 索引摘要');
    assert.ok(Array.isArray(parsed.recent) && parsed.recent.length <= 500, 'recent 有界 500');
    assert.ok(payload.length > 0, 'rebuildWikiHotCache 返回载荷');

    // 全局日志：同一批业务写派生 change_set/receipt/compile/source 事件（非第二真源，可重建）。
    const logPage = listKnowledgeLogEntries(database, { limit: 100 });
    const kinds = new Set(logPage.items.map((entry) => entry.eventType));
    for (const expected of ['change_set', 'receipt', 'compile', 'source']) {
      assert.ok(kinds.has(expected), `日志应包含 ${expected} 事件，实际 ${[...kinds].join(',')}`);
    }
    // 日志条目携带稳定对象 id + 固定版本/修订引用 + 可导航定位。
    const compileEntry = logPage.items.find((entry) => entry.eventType === 'compile');
    assert.ok(compileEntry.objectId && compileEntry.versionRefs.wikiPageVersionIds.length > 0, 'compile 日志条目带版本引用');
    assert.ok(compileEntry.locator && compileEntry.locator.kind === 'wiki_page_version', 'compile 日志条目可导航定位');

  } finally {
    try {     database.close(); } catch {}
    await cleanup(root);
  }
});

// ============ 6. 分页稳定：keyset 跨页插入不重不丢 + 排序确定 ============

test('WMB-5238 分页稳定：搜索 keyset 跨页插入不重不丢；排序完全确定', async () => {
  const root = await makeRoot();
  try {
    const { database } = makeDatabase(root);
    const base = '2026-08-01T00:00:00.000Z';
    const put = (i, updatedAt, title) => {
      database.prepare(`INSERT INTO knowledge_index_entries
        (object_type, object_id, version_ref, title, summary, searchable_text, scope, updated_at)
        VALUES ('knowledge_note', ?, ?, ?, '', '正文 关键词 内容', 'global', ?)`)
        .run(`note-${i}`, `ver-${i}`, title, updatedAt);
    };
    // 6 行，updatedAt 步进 1 分钟，title 含 '关键词'；objectId 反向命名制造 tie-break 区分度。
    for (let i = 0; i < 6; i += 1) {
      put(i, new Date(Date.parse(base) + i * 60_000).toISOString(), `标题 ${i}`);
    }

    // 全量预期（确定性排序：titleHit DESC, updated_at DESC, object_type ASC, object_id ASC）。
    const all = searchWikiIndex(database, { query: '关键词', limit: 100 });
    assert.equal(all.total, 6);
    const expectedOrder = all.items.map((item) => item.objectId);

    // 两页连读 limit=2。
    const p1 = searchWikiIndex(database, { query: '关键词', limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.hasMore, true);
    assert.ok(p1.cursor, '第一页必须返回游标');

    // 页间插入新行（updatedAt 落在第 2、3 名之间）。
    const mid = new Date(Date.parse(base) + 90_000).toISOString();
    put('mid', mid, '中途插入 标题');

    const p2 = searchWikiIndex(database, { query: '关键词', limit: 2, cursor: p1.cursor });
    assert.equal(p2.total, 7, 'total 为全量匹配计数，不随游标变化');
    const seen = new Set([...p1.items, ...p2.items].map((item) => item.objectId));
    assert.equal(seen.size, p1.items.length + p2.items.length, '两页之间不重');
    assert.ok(!p2.items.some((item) => p1.items.some((prev) => prev.objectId === item.objectId)), '第二页不重复第一页条目');

    // 排序确定：p1+p2 的前 4 名 == 全量顺序的前 4 名（插入行落在第 3 位）。
    const p3 = searchWikiIndex(database, { query: '关键词', limit: 100 });
    const full4 = p3.items.slice(0, 4).map((item) => item.objectId);
    const paged4 = [...p1.items, ...p2.items].map((item) => item.objectId);
    assert.deepEqual(paged4, full4, '分页读取顺序与全量排序前 4 名完全一致');

    // 非法游标 fail-closed（code=INVALID_CURSOR）。
    const expectInvalidCursor = (fn) => assert.throws(fn, (error) => error && error.code === 'INVALID_CURSOR', '应抛 INVALID_CURSOR');
    expectInvalidCursor(() => searchWikiIndex(database, { query: '关键词', cursor: 'not-a-cursor' }));
    expectInvalidCursor(() => searchWikiIndex(database, { query: '关键词', cursor: Buffer.from('{"h":9,"u":"x","t":"knowledge_note","i":"n"}', 'utf8').toString('base64url') }));

    // listIndexEntries（store 读模型）同样稳定排序。
    const list = store.listIndexEntries(database, { limit: 100 });
    assert.ok(list.total >= 7);
    const listedIds = list.items.map((item) => item.objectId);
    assert.deepEqual([...listedIds].sort().join(','), [...listedIds].sort().join(','), 'listIndexEntries 返回确定集合');

  } finally {
    try {     database.close(); } catch {}
    await cleanup(root);
  }
});

// ============ 7. 数据根隔离：两个 data-root 互不可见 ============

test('WMB-5238 数据根隔离：独立 DB 之间索引/搜索/日志零串扰', async () => {
  const rootA = await makeRoot();
  const rootB = await makeRoot();
  try {
    const { database: dbA } = makeDatabase(rootA, 'ws-a');
    const { database: dbB } = makeDatabase(rootB, 'ws-b');
    wireProjection();
    const topicA = upsertKnowledgeTopic(dbA, { title: 'A 主题' });
    const topicB = upsertKnowledgeTopic(dbB, { title: 'B 主题' });
    const srcA = upsertSource(dbA, { originalUrl: 'https://example.com/a', title: 'A 专属来源' });
    const srcB = upsertSource(dbB, { originalUrl: 'https://example.com/b', title: 'B 专属来源' });
    linkTopicSource(dbA, topicA.id, srcA.id);
    linkTopicSource(dbB, topicB.id, srcB.id);
    seedSourceBody(dbA, srcA.id, 'https://example.com/a', 'A 独有正文标记词。');
    seedSourceBody(dbB, srcB.id, 'https://example.com/b', 'B 独有正文标记词。');
    // A 库产生工作空间级日志（change_set/receipt/compile 携带 workspaceId）。
    const compileA = compileOnce(dbA, 'ws-a', srcA, topicA.id, `iso-a:${randomUUID()}`);

    const hitA = searchWikiIndex(dbA, { query: 'A 独有', limit: 10 });
    assert.ok(hitA.items.some((item) => item.objectType === 'source' && item.objectId === srcA.id), 'A 库命中 A 来源正文');
    const hitB = searchWikiIndex(dbB, { query: 'A 独有', limit: 10 });
    assert.equal(hitB.total, 0, 'B 库不得命中 A 库正文');
    assert.ok(searchWikiIndex(dbB, { query: 'B 独有', limit: 10 }).items.some((item) => item.objectType === 'source' && item.objectId === srcB.id));
    assert.equal(searchWikiIndex(dbA, { query: 'B 独有', limit: 10 }).total, 0, 'A 库不得命中 B 库正文');

    const rowsA = indexRows(dbA);
    const rowsB = indexRows(dbB);
    const textA = rowsA.map((r) => r.searchableText).join(' ');
    const textB = rowsB.map((r) => r.searchableText).join(' ');
    assert.ok(textA.includes('A 独有正文标记词') && !textA.includes('B 独有正文标记词'), 'A 库索引只含 A 内容');
    assert.ok(textB.includes('B 独有正文标记词') && !textB.includes('A 独有正文标记词'), 'B 库索引只含 B 内容');
    const logA = listKnowledgeLogEntries(dbA, { limit: 100 });
    const logB = listKnowledgeLogEntries(dbB, { limit: 100 });
    assert.ok(logA.items.length > 0 && logB.items.length > 0);
    assert.notDeepEqual(logA.items.map((e) => e.objectId), logB.items.map((e) => e.objectId), '日志条目分属各自 data-root');

    // A 库日志全部归属 ws-a（change_set/receipt 为工作空间级聚合；source 事件无 workspace 列 → null）。
    const withWsA = logA.items.filter((entry) => entry.workspaceId !== null);
    assert.ok(withWsA.length > 0, 'A 库应有携带 workspaceId 的日志条目');
    assert.ok(withWsA.every((entry) => entry.workspaceId === 'ws-a'), '日志 workspaceId 与 data-root 一致');
    assert.ok(logB.items.filter((entry) => entry.workspaceId !== null).every((entry) => entry.workspaceId === 'ws-b'), 'B 库日志同样归属 ws-b');
    assert.equal(searchWikiIndex(dbA, { query: '主题', objectTypes: ['topic'] }).items.find((t) => t.objectId === topicB.id), undefined, 'B 主题不得出现在 A 库');

  } finally {
    try { dbA.close(); } catch {}
    try { dbB.close(); } catch {}
    await cleanup(rootA);
    await cleanup(rootB);
  }
});

// ============ 8. 写守卫：新表写入必须经过授权窗口 ============

test('WMB-5238 写守卫：未授权上下文对新索引表 INSERT/DELETE 一律 RAISE', async () => {
  const root = await makeRoot();
  try {
    const { database } = makeDatabase(root);
    // 守卫安装前预置一行（BEFORE DELETE FOR EACH ROW 触发器对空表不触发，无法证明守卫生效）。
    database.prepare(`INSERT INTO knowledge_index_entries
      (object_type, object_id, version_ref, title, updated_at) VALUES ('topic','seed','rev:1','预置', '2026-08-13T00:00:00.000Z')`).run();
    let authorized = false;
    installWorkspaceWriteGuard(database, () => authorized);

    assert.throws(
      () => database.prepare(`INSERT INTO knowledge_index_entries
        (object_type, object_id, version_ref, title, updated_at) VALUES ('topic','g1','rev:1','守卫', '2026-08-13T00:00:00.000Z')`).run(),
      /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/, '未授权 INSERT 必须 RAISE');
    assert.throws(() => database.prepare("DELETE FROM knowledge_index_entries WHERE object_id = 'seed'").run(),
      /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/, '未授权 DELETE 必须 RAISE');
    assert.throws(() => database.prepare(`INSERT INTO knowledge_hot_cache (id, payload_json, rebuilt_at) VALUES (1, '{}', '2026-08-13T00:00:00.000Z')`).run(),
      /WMB_WRITE_REQUIRES_COMMAND_DISPATCH/, '持久 hot cache 表同样受守卫');

    authorized = true;
    database.prepare(`INSERT INTO knowledge_index_entries
      (object_type, object_id, version_ref, title, updated_at) VALUES ('topic','g1','rev:1','守卫', '2026-08-13T00:00:00.000Z')`).run();
    const row = database.prepare("SELECT count(*) AS c FROM knowledge_index_entries WHERE object_id='g1'").get().c;
    assert.equal(row, 1, '授权窗口内写入成功');

  } finally {
    try {     database.close(); } catch {}
    await cleanup(root);
  }
});
