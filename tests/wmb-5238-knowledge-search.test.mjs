// WMB-5238：统一全文搜索 + 索引摘要 + 有界 hot cache 只读 store 聚焦测试（本 worker：ImplementWikiUnifiedSearch）。
// 验收（局部测试，真实 SQLite）：跨对象命中、版本锚点、稳定排序/分页、scope 过滤、
// 空查询/非法游标 fail-closed、缓存重建一致性、输入界限。只读断言，不改 schema/migration registry。
// 运行：node --test --test-concurrency=1 tests/wmb-5238-knowledge-search.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const {
  searchWikiIndex,
  getWikiIndexSummary,
  getWikiHotCache,
  rebuildWikiHotCache,
  KnowledgeSearchError
} = await import('../src/main/knowledge-search.ts');

// ============ fixtures / helpers ============
// 索引表由 migration 63（wiki-index-migrations.ts）创建：compile_status NOT NULL DEFAULT 'current'。
// 本测试只写该表的派生行（UPSERT），不改 schema / migration registry。

async function makeRoot(prefix = 'wmb-5238-search-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeDatabase(root) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(`ws-${randomUUID()}`, now, now);
  return database;
}

/** 每个测试统一收尾：先 close 再 rm（避免 open SQLite 文件阻塞 Windows rm）。 */
async function withDatabase(root, fn) {
  const database = makeDatabase(root);
  try {
    return await fn(database);
  } finally {
    database.close();
  }
}

function insertIndexRow(database, row) {
  database.prepare(`
    INSERT INTO knowledge_index_entries
      (object_type, object_id, version_ref, title, summary, searchable_text, topic_ids_json, scope, compile_status, updated_at, nav_object_type, nav_object_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(object_type, object_id) DO UPDATE SET
      version_ref = excluded.version_ref, title = excluded.title, summary = excluded.summary,
      searchable_text = excluded.searchable_text, topic_ids_json = excluded.topic_ids_json,
      scope = excluded.scope, compile_status = excluded.compile_status, updated_at = excluded.updated_at,
      nav_object_type = excluded.nav_object_type, nav_object_id = excluded.nav_object_id
  `).run(
    row.objectType, row.objectId, row.versionRef, row.title, row.summary ?? '',
    row.searchableText, JSON.stringify(row.topicIds ?? []), row.scope ?? 'global',
    row.compileStatus ?? 'current', row.updatedAt, row.navObjectType ?? null, row.navObjectId ?? null
  );
}

function seedFixture(database) {
  // 六类对象：Wiki 正文 / Knowledge Note / Entity / Topic / Source / 固定版本引用
  insertIndexRow(database, {
    objectType: 'wiki_page', objectId: 'page-a', versionRef: 'wiki_page:page-a:ver-1',
    title: '小红书运营方法论', summary: '平台算法与内容节奏',
    searchableText: '小红书平台的核心是搜索推荐算法，标题决定曝光，正文决定完读。',
    topicIds: ['topic-xhs'], scope: 'global', compileStatus: 'current', updatedAt: '2026-08-01T00:00:00.000Z'
  });
  insertIndexRow(database, {
    objectType: 'knowledge_note', objectId: 'note-b', versionRef: 'knowledge_note:note-b:ver-7',
    title: '标题命中优先原则', summary: '标题关键词影响搜索分发',
    searchableText: '标题包含用户搜索词时，命中优先于正文命中，点击率显著提升。',
    topicIds: ['topic-xhs', 'topic-seo'], scope: 'global', compileStatus: 'current', updatedAt: '2026-08-02T00:00:00.000Z'
  });
  insertIndexRow(database, {
    objectType: 'entity', objectId: 'entity-c', versionRef: 'entity:entity-c:3',
    title: '微信生态', summary: '', searchableText: '微信公众号与视频号构成私域闭环，搜索词包括微信号。',
    topicIds: ['topic-seo'], scope: 'global', updatedAt: '2026-08-03T00:00:00.000Z'
  });
  insertIndexRow(database, {
    objectType: 'topic', objectId: 'topic-xhs', versionRef: 'topic:topic-xhs:5',
    title: '小红书爆款策略', summary: '搜索关键词与封面设计',
    searchableText: '小红书爆款依赖搜索关键词布局与封面点击率。',
    topicIds: ['topic-xhs'], scope: 'global', updatedAt: '2026-08-04T00:00:00.000Z'
  });
  insertIndexRow(database, {
    objectType: 'source', objectId: 'source-d', versionRef: 'source:source-d:2',
    title: '平台算法解读报告', summary: '2026 搜索推荐趋势',
    searchableText: '报告指出搜索推荐算法向内容质量倾斜。',
    topicIds: ['topic-seo'], scope: 'lane:uk', updatedAt: '2026-08-05T00:00:00.000Z'
  });
  insertIndexRow(database, {
    objectType: 'fixed_version_reference', objectId: 'ev-1', versionRef: 'knowledge_note:note-b:ver-7',
    title: '固定版本引用：标题命中优先原则', summary: '证据链指向 note-b ver-7',
    searchableText: '引用固定版本：标题命中优先原则 ver-7。',
    topicIds: ['topic-xhs'], scope: 'global', updatedAt: '2026-08-06T00:00:00.000Z',
    navObjectType: 'knowledge_note', navObjectId: 'note-b'
  });
}

// ============ 测试 ============

test('WMB-5238 统一搜索：跨对象命中 + 版本锚点 + 导航载荷', async () => {
  const root = await makeRoot();
  try {
    await withDatabase(root, (database) => {
      seedFixture(database);

      // 1) 跨对象命中：'标题' 同时命中 note（标题）、fixed_version_reference（标题）、wiki_page（正文）
      const page = searchWikiIndex(database, { query: '标题', limit: 20 });
      assert.equal(page.total, 3, '三行含「标题」');
      const types = page.items.map((item) => item.objectType).sort();
      assert.deepEqual(types, ['fixed_version_reference', 'knowledge_note', 'wiki_page']);

      // 2) 版本锚点：所有命中必须携带固定版本/修订引用（不得裸对象 ID）
      for (const item of page.items) {
        assert.ok(item.versionRef && item.versionRef.length > 0, `versionRef 非空 ${item.objectType}`);
        // 非 fvr 行：versionRef 锚定对象自身；fvr 行：指向被引不可变版本
        if (item.objectType !== 'fixed_version_reference') {
          assert.ok(item.versionRef.includes(item.objectId), `versionRef 锚定对象 ${item.objectType}`);
        }
        assert.match(item.versionRef, /^(wiki_page|knowledge_note|entity|topic|source):.+:(ver-|v|r|rev:)?/);
      }
      const noteHit = page.items.find((item) => item.objectType === 'knowledge_note');
      assert.equal(noteHit.versionRef, 'knowledge_note:note-b:ver-7', 'note 当前命中仍返回固定版本 id');
      const refHit = page.items.find((item) => item.objectType === 'fixed_version_reference');
      assert.equal(refHit.versionRef, 'knowledge_note:note-b:ver-7', '固定版本引用锚定同一不可变版本');

      // 3) 载荷契约：objectType + objectId + versionRef + title + snippet + updatedAt + navigation
      for (const item of page.items) {
        assert.ok(item.objectType && item.objectId && item.versionRef && item.title, '核心字段非空');
        assert.ok(item.snippet.includes('标题'), `snippet 包含命中词：${item.snippet}`);
        assert.ok(item.updatedAt, 'updatedAt 非空');
        assert.ok(item.navigation && typeof item.navigation.route === 'string' && item.navigation.targetId, 'navigation 载荷存在');
      }
      // 4) 导航同源：fixed_version_reference 指向 note-b（业务表未种 → exists=false 但 targetId 同 ID 空间）
      const nav = refHit.navigation;
      assert.equal(nav.targetId, 'note-b', '固定版本引用导航指向所引对象（同一 ID 空间）');
      assert.equal(nav.objectId, 'note-b');
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('WMB-5238 稳定排序/分页：标题命中优先 + 确定可复现 + 两页不重不丢', async () => {
  const root = await makeRoot();
  try {
    await withDatabase(root, (database) => {
      seedFixture(database);

      // 标题命中优先：'平台' 命中 source 标题（lane:uk）+ wiki_page 正文 → total 2
      const first = searchWikiIndex(database, { query: '平台', limit: 1 });
      assert.equal(first.total, 2, '两行含「平台」');
      assert.equal(first.items.length, 1);
      assert.ok(first.hasMore, '第一页 hasMore');
      assert.ok(first.cursor, '第一页有 nextCursor');

      // 标题命中优先：source 标题含「平台」，应排在仅正文命中的 wiki_page 之前
      assert.equal(first.items[0].objectType, 'source', '标题命中（source）优先于正文命中');

      // 第二页：不重不丢
      const second = searchWikiIndex(database, { query: '平台', limit: 1, cursor: first.cursor });
      assert.equal(second.items.length, 1, '第二页 1 行');
      assert.equal(second.hasMore, false);
      assert.equal(second.cursor, null);
      const ids = [...first.items, ...second.items].map((item) => `${item.objectType}:${item.objectId}`).sort();
      assert.deepEqual(ids, ['source:source-d', 'wiki_page:page-a'].sort(), '两页恰好覆盖全部命中');

      // 确定可复现：同输入同输出
      const again = searchWikiIndex(database, { query: '平台', limit: 1 });
      assert.deepEqual(again.items.map((item) => `${item.objectType}:${item.objectId}`),
        first.items.map((item) => `${item.objectType}:${item.objectId}`), '同输入同输出（幂等）');
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('WMB-5238 scope 过滤：objectTypes / topicId / scope / 组合', async () => {
  const root = await makeRoot();
  try {
    await withDatabase(root, (database) => {
      seedFixture(database);

      // 1) objectTypes 过滤：只搜 wiki_page + knowledge_note
      const typed = searchWikiIndex(database, { query: '标题', objectTypes: ['wiki_page', 'knowledge_note'] });
      assert.equal(typed.total, 2);
      assert.ok(typed.items.every((item) => ['wiki_page', 'knowledge_note'].includes(item.objectType)));

      // 2) topicId 过滤：topic-seo 关联 3 行（note/entity/source），'搜索' 命中三者
      const byTopic = searchWikiIndex(database, { query: '搜索', topicId: 'topic-seo' });
      assert.equal(byTopic.total, 3, 'topic-seo 下三行含「搜索」');
      const noTopic = searchWikiIndex(database, { query: '搜索', topicId: 'topic-other' });
      assert.equal(noTopic.total, 0, '未关联 topic 零命中');

      // 3) scope 过滤：lane:uk 只命中 source；global 命中 wiki_page 正文（source 是 lane:uk 不计入）
      const lane = searchWikiIndex(database, { query: '算法', scope: 'lane:uk' });
      assert.equal(lane.total, 1);
      assert.equal(lane.items[0].objectType, 'source');
      const global = searchWikiIndex(database, { query: '算法', scope: 'global' });
      assert.equal(global.total, 1, 'global 只命中 wiki 正文行（source 在 lane:uk 被 scope 隔离）');
      assert.equal(global.items[0].objectType, 'wiki_page');

      // 4) 组合：objectTypes + topicId + scope 全部生效（'爆款' 仅 topic 行标题含）
      const combo = searchWikiIndex(database, { query: '爆款', objectTypes: ['topic'], topicId: 'topic-xhs' });
      assert.equal(combo.total, 1);
      assert.equal(combo.items[0].objectType, 'topic');
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('WMB-5238 空查询 + 非法游标 + 非法输入 fail-closed + limit 界限', async () => {
  const root = await makeRoot();
  try {
    await withDatabase(root, (database) => {
      seedFixture(database);

      // 1) 空查询：空结果 total 0（契约语义，非全量分页）
      for (const empty of ['', '   ', undefined, null]) {
        const result = searchWikiIndex(database, { query: empty, limit: 20 });
        assert.equal(result.total, 0, `空查询 total 0 (${JSON.stringify(empty)})`);
        assert.deepEqual(result.items, []);
        assert.equal(result.hasMore, false);
        assert.equal(result.cursor, null);
      }

      // 2) 非法游标：损坏 / 结构非法 / 越界字段 → INVALID_CURSOR
      const invalidCursors = [
        'not-base64!!!',
        Buffer.from('{"h":0}', 'utf8').toString('base64url'),
        Buffer.from('{"h":2,"u":"2026","t":"topic","i":"x"}', 'utf8').toString('base64url'),
        Buffer.from('{"h":0,"u":"2026","t":"bogus","i":"x"}', 'utf8').toString('base64url'),
        Buffer.from('{"h":0,"u":"","t":"topic","i":"x"}', 'utf8').toString('base64url')
      ];
      for (const cursor of invalidCursors) {
        assert.throws(
          () => searchWikiIndex(database, { query: '平台', cursor, limit: 5 }),
          (error) => error instanceof KnowledgeSearchError && error.code === 'INVALID_CURSOR',
          `非法游标 fail-closed：${cursor.slice(0, 20)}`
        );
      }

      // 3) 非法输入：未知对象类型 / 非法 scope / 非法 limit → INVALID_INPUT
      assert.throws(() => searchWikiIndex(database, { query: 'x', objectTypes: ['bogus'] }),
        (error) => error instanceof KnowledgeSearchError && error.code === 'INVALID_INPUT');
      assert.throws(() => searchWikiIndex(database, { query: 'x', objectTypes: [] }),
        (error) => error instanceof KnowledgeSearchError && error.code === 'INVALID_INPUT');
      assert.throws(() => searchWikiIndex(database, { query: 'x', scope: 'lane:UPPER!' }),
        (error) => error instanceof KnowledgeSearchError && error.code === 'INVALID_INPUT');
      assert.throws(() => searchWikiIndex(database, { query: 'x', limit: '20' }),
        (error) => error instanceof KnowledgeSearchError && error.code === 'INVALID_INPUT');

      // 4) limit 界限：0 → 1（下限钳制）；1000 → 100（上限钳制）
      const tiny = searchWikiIndex(database, { query: '平台', limit: 0 });
      assert.equal(tiny.limit, 1);
      const huge = searchWikiIndex(database, { query: '平台', limit: 1000 });
      assert.equal(huge.limit, 100);
      assert.ok(huge.items.length <= 100);
    });

    // 5) 索引表缺失 → INDEX_TABLE_NOT_FOUND（未迁移的裸 DB；先 close 再 rm）
    const bareRoot = await makeRoot('wmb-5238-bare-');
    const bare = new (await import('node:sqlite')).DatabaseSync(path.join(bareRoot, 'bare.db'));
    try {
      assert.throws(() => searchWikiIndex(bare, { query: 'x' }),
        (error) => error instanceof KnowledgeSearchError && error.code === 'INDEX_TABLE_NOT_FOUND');
    } finally {
      bare.close();
      await rm(bareRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('WMB-5238 索引摘要 + 有界 hot cache：重建一致性 + 非真源 + 有界', async () => {
  const root = await makeRoot();
  try {
    await withDatabase(root, (database) => {
      seedFixture(database);

      // 1) 索引摘要（权威）：六类 counts + total + updatedAt
      const summary = getWikiIndexSummary(database);
      assert.equal(summary.total, 6);
      assert.equal(summary.counts.wiki_page, 1);
      assert.equal(summary.counts.knowledge_note, 1);
      assert.equal(summary.counts.entity, 1);
      assert.equal(summary.counts.topic, 1);
      assert.equal(summary.counts.source, 1);
      assert.equal(summary.counts.fixed_version_reference, 1);
      assert.equal(summary.updatedAt, '2026-08-06T00:00:00.000Z', '最新索引更新时间');

      // 2) hot cache 等价读模型：与索引摘要一致（非独立真源）
      const firstCache = getWikiHotCache(database);
      assert.equal(firstCache.cached, true);
      assert.equal(firstCache.entryCount, 6, '条目数 = 索引行数');
      assert.equal(firstCache.maxEntries, 500, '有界上限 500');
      assert.equal(firstCache.summary.total, summary.total);
      assert.deepEqual(firstCache.summary.counts, summary.counts);

      // 3) 重建一致性：强制重建后摘要与权威一致；再次读取命中缓存（rebuiltAt 不变）
      const rebuilt = rebuildWikiHotCache(database);
      assert.equal(rebuilt.entryCount, 6);
      assert.equal(rebuilt.summary.total, 6);
      const cachedAgain = getWikiHotCache(database);
      assert.equal(cachedAgain.rebuiltAt, rebuilt.rebuiltAt, '未变化时命中缓存不重建');

      // 4) 数据变化 → 指纹变化 → 惰性重建（缓存非真源，反映索引新状态）
      insertIndexRow(database, {
        objectType: 'topic', objectId: 'topic-seo', versionRef: 'topic:topic-seo:9',
        title: '搜索优化', summary: '关键词布局',
        searchableText: '搜索优化围绕关键词布局与内容质量。',
        topicIds: ['topic-seo'], scope: 'global', updatedAt: '2026-08-07T00:00:00.000Z'
      });
      const refreshed = getWikiHotCache(database);
      assert.equal(refreshed.summary.total, 7, '索引变化后 hot cache 反映新状态（非真源）');
      assert.equal(refreshed.summary.counts.topic, 2);
      assert.equal(refreshed.summary.updatedAt, '2026-08-07T00:00:00.000Z');

      // 5) 搜索不受缓存影响（直接读索引表）
      const search = searchWikiIndex(database, { query: '搜索优化' });
      assert.equal(search.total, 1);
      assert.equal(search.items[0].objectId, 'topic-seo');
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
