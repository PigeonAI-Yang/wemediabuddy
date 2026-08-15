import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 纯 Node ESM：测试图内的 src/main 模块全部使用显式 .ts 扩展名，无需解析 hook。
// 运行：node --test --test-concurrency=1 tests/wmb-5229-knowledge-compile-trigger.test.mjs

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const { dispatchSourceUpsertBatch } = await import('../src/main/source-commands.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { setDataChangedPublisher } = await import('../src/main/data-changed.ts');
const {
  KNOWLEDGE_COMPILE_COMMAND,
  knowledgeCompileTopicRequestId,
  setSourceKnowledgeCompileDeps,
  scheduleSourceKnowledgeCompileWith,
  runSourceKnowledgeCompile,
  drainSourceKnowledgeCompileQueue,
  sourceKnowledgeCompileInFlight
} = await import('../src/main/knowledge-compile-trigger.ts');
const { bindXList } = await import('../src/main/x-lists.ts');
const { writeXListTimelineCache } = await import('../src/main/x-list-timeline-cache.ts');
const { runEnabledXListWire } = await import('../src/main/intelligence-wire.ts');
const { xMetricEvidenceMap } = await import('../src/main/platforms/metric-value.ts');
const { persistBoundXListTimeline } = await import('../src/main/x-list-execution.ts');
const { createWebsiteSource } = await import('../src/main/intelligence-channels.ts');
const { persistWebsiteSourceScan } = await import('../src/main/website-channel.ts');

const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5229-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeDatabase(root) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  const workspaceId = `ws-${randomUUID()}`;
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return { database, workspaceId };
}

function fenced(manifest) {
  return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``;
}

function goodManifest() {
  return {
    wmb_knowledge_candidates: {
      reason: 'fixture 知识编译触发测试。',
      topicCompile: { title: '触发测试 Wiki', summary: '从 Source 编译的 Topic Wiki' },
      entities: [
        { entityType: 'product', canonicalKey: 'agentforge', canonicalName: 'AgentForge', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方产品身份，可独立验证。' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: 'agentforge-v2-router', statement: 'AgentForge v2 支持多模型路由。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方发布，可验证。' }
      ]
    }
  };
}

const SOURCE_SUMMARY = [
  'AgentForge v2 正式发布，支持多模型路由。',
  '官方定价为每百万 token 0.8 美元。',
  '社区反馈称高峰时段延迟明显上升。'
].join('\n');

function modelOf(text) {
  return async () => text;
}

function linkTopic(database, sourceId, topicId) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
    .run(topicId, sourceId, 'primary', now, now);
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
}

function compileOperations(database) {
  return database.prepare(`SELECT entity_id AS entityId, result, error_code AS errorCode, before_revision AS beforeRevision, after_revision AS afterRevision
    FROM operation_log WHERE command = ? ORDER BY created_at, id`).all(KNOWLEDGE_COMPILE_COMMAND);
}

function receipts(database) {
  return database.prepare('SELECT request_id AS requestId, trigger_type AS triggerType FROM knowledge_update_receipts ORDER BY request_id').all();
}

async function captureBroadcasts(work) {
  const events = [];
  setDataChangedPublisher((event) => events.push(event));
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    setDataChangedPublisher(null);
  }
  // 直写路径 upsertSource 会带 'source.upsert' reason 广播，reason 是逗号合并串 → 按 scopes 过滤。
  return events.filter((event) =>
    event.scopes.includes('knowledge') && event.scopes.includes('topics') && event.scopes.includes('receipt'));
}

/** 每个测试独立 root + 显式 deps（databasePath 指向同一文件；编译连接由 migrateDatabase 打开）。 */
function depsFor(root, modelCall, extra = {}) {
  return {
    databasePath: path.join(root, 'wmb.db'),
    modelCall,
    openDatabase: migrateDatabase,
    ...extra
  };
}

async function drain() {
  await drainSourceKnowledgeCompileQueue();
  assert.equal(sourceKnowledgeCompileInFlight(), 0);
}

// ============ A. 命令入口（dispatcher sources.upsert_batch）：已关联 Topic → 异步编译 ============

test('WMB-5229 command entry: upsert_batch schedules async compile for linked topic with broadcast', async () => {
  const root = await makeRoot();
  let runtime;
  try {
    // 生产语义：Source 保存前 topic_source_links 已存在（发现/整理阶段建立）。
    // 预置 Source + Topic + 链接，再经 dispatcher 更新保存（revision bump）触发编译。
    const seeded = await makeDatabase(root);
    const source = upsertSource(seeded.database, {
      title: 'AgentForge v2 官方公告',
      originalUrl: 'https://news.example/agentforge-v2',
      summary: SOURCE_SUMMARY
    });
    const topic = upsertKnowledgeTopic(seeded.database, { title: 'AI Agent 工具链' });
    linkTopic(seeded.database, source.id, topic.id);
    seeded.database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    const database = runtime.database;
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));

    const events = [];
    setDataChangedPublisher((event) => events.push(event));
    try {
      const receipt = await dispatchSourceUpsertBatch(runtime, {
        requestId: `cmd-save-${randomUUID()}`, actor: owner,
        items: [{ title: 'AgentForge v2 官方公告（更新）', originalUrl: 'https://news.example/agentforge-v2', summary: SOURCE_SUMMARY }]
      });
      assert.equal(receipt.ok, true);
      const saved = receipt.data.items[0];
      assert.equal(saved.id, source.id);
      assert.equal(saved.revision, 2, 'dispatcher 更新保存 → revision 2');

      // 保存事务已提交、命令已返回；编译异步执行。
      await drain();
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      setDataChangedPublisher(null);
    }

    assert.equal(sourceKnowledgeCompileInFlight(), 0);
    const ops = compileOperations(database);
    assert.equal(ops.length, 1, '一个 Topic → 一条 knowledge.compile_source 操作');
    assert.equal(ops[0].result, 'ok');
    assert.equal(ops[0].beforeRevision, 2);
    const expectedRequestId = knowledgeCompileTopicRequestId(source.id, 2, topic.id);
    assert.deepEqual(receipts(database).map((row) => row.requestId), [expectedRequestId]);
    assert.equal(count(database, 'knowledge_notes'), 1, '编译晋升 1 条 Note');
    assert.equal(count(database, 'knowledge_entities'), 1);
    assert.equal(count(database, 'knowledge_wiki_pages'), 1);
    const compileEvents = events.filter((event) => event.scopes.includes('knowledge') && event.scopes.includes('topics') && event.scopes.includes('receipt'));
    assert.ok(compileEvents.length >= 1, '成功广播 knowledge/topics/receipt dataChanged');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ B. 命令入口：未关联 Topic → 干净 no-op（零写、零广播） ============

test('WMB-5229 command entry: unlinked source compiles nothing and broadcasts nothing', async () => {
  const root = await makeRoot();
  let runtime;
  try {
    const seeded = await makeDatabase(root);
    seeded.database.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'runtime-current' });
    const database = runtime.database;
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));

    const receipt = await dispatchSourceUpsertBatch(runtime, {
      requestId: `cmd-unlinked-${randomUUID()}`, actor: owner,
      items: [{ title: '孤立 Source', originalUrl: 'https://news.example/orphan', summary: SOURCE_SUMMARY }]
    });
    assert.equal(receipt.ok, true);
    const events = await captureBroadcasts(() => drain());

    assert.equal(compileOperations(database).length, 0, '未关联 Topic 不产生编译操作');
    assert.equal(count(database, 'knowledge_update_receipts'), 0);
    assert.equal(count(database, 'knowledge_change_sets'), 0);
    assert.equal(count(database, 'knowledge_notes'), 0);
    assert.equal(events.length, 0, '未关联不广播 source.compile');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    await runtime?.stop({ drain: false });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ C. 直写入口：website-channel persistWebsiteSourceScan ============

test('WMB-5229 direct-write entry: website-channel scan schedules compile', async () => {
  const root = await makeRoot();
  const { database, workspaceId } = await makeDatabase(root);
  try {
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));
    const canonicalUrl = 'https://fixture.example/agentforge-changelog';
    const trialRead = {
      url: canonicalUrl,
      requestedUrl: canonicalUrl,
      title: 'AgentForge Changelog',
      readable: true,
      httpStatus: 200,
      contentType: 'text/html'
    };
    const source = createWebsiteSource(database, {
      inputText: canonicalUrl,
      name: 'AgentForge 官网',
      canonicalUrl,
      resolutionStatus: 'ready',
      trialRead,
      notify: false
    });
    const body = ['# Changelog', '', 'January 5, 2026 · AgentForge v2 正式发布，支持多模型路由。'].join('\n');
    const read = { original: source, checkedAt: new Date().toISOString(), page: { body, trialRead } };
    // 直写保存（同步）→ 立即同步补链（编译在下一微任务执行，此时链接已可见）→ drain。
    const result = persistWebsiteSourceScan(database, { taskId: 'task-1', workspaceId, sourceId: source.id }, read);
    assert.equal(result.sourceIds.length, 1, '官网扫描保存 1 条 Source');
    const topic = upsertKnowledgeTopic(database, { title: 'AgentForge 官网动态' });
    linkTopic(database, result.sourceIds[0], topic.id);

    const events = await captureBroadcasts(() => drain());
    assert.equal(compileOperations(database).length, 1, '已关联 → 编译 1 个 Topic');
    assert.equal(compileOperations(database)[0].result, 'ok');
    assert.equal(count(database, 'knowledge_notes'), 1);
    assert.ok(events.length >= 1, '直写成功广播 knowledge/topics/receipt');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ D. 直写入口：x-list-execution persistBoundXListTimeline ============

test('WMB-5229 direct-write entry: x-list timeline persist schedules compile', async () => {
  const root = await makeRoot();
  const { database, workspaceId } = await makeDatabase(root);
  try {
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));
    const accountKey = '@fixture_account';
    const listId = '998877665544332211';
    const bound = bindXList(database, {
      accountKey,
      list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: accountKey, name: 'AI 前沿', kind: 'owned' },
      notify: false
    });
    assert.equal(bound.ok, true);
    const binding = bound.data;
    const capturedAt = new Date().toISOString();
    const metricEvidence = xMetricEvidenceMap({ replies: '10', reposts: '5', likes: '100', bookmarks: '3', views: '1000' }, 'graphql');
    const post = {
      url: `https://x.com/fixture_account/status/1`,
      authorHandle: 'fixture_account',
      displayName: null,
      avatarUrl: null,
      text: 'AgentForge v2 正式发布，支持多模型路由。',
      postedAt: '2026-08-12T00:00:00.000Z',
      images: [],
      imageThumbs: [],
      hasVideo: false,
      videoPoster: null,
      videoUrl: null,
      metrics: { replies: 10, reposts: 5, likes: 100, bookmarks: 3, views: 1000 },
      metricEvidence
    };
    const read = {
      binding,
      timeline: {
        accountKey,
        detail: {
          listId,
          canonicalUrl: `https://x.com/i/lists/${listId}`,
          name: 'AI 前沿',
          ownerHandle: accountKey,
          kind: 'owned',
          description: '',
          isPrivate: false,
          memberCount: null,
          observation: { capturedAt, pageUrl: `https://x.com/i/lists/${listId}`, fingerprint: 'fp', visibleText: '' }
        },
        posts: [post],
        hasMore: false
      }
    };
    const collected = persistBoundXListTimeline(database, { id: 'fixture-browser', cdpUrl: 'http://127.0.0.1:9999', workspaceId }, {
      accountKey, listId, limit: 50
    }, read);
    assert.equal(collected.ok, true, collected.error?.message ?? '');
    assert.equal(collected.data.sourceIds.length, 1, 'X List 采集保存 1 条 Source');

    const topic = upsertKnowledgeTopic(database, { title: 'X List 情报' });
    linkTopic(database, collected.data.sourceIds[0], topic.id);

    const events = await captureBroadcasts(() => drain());
    assert.equal(compileOperations(database).length, 1, '已关联 → 编译 1 个 Topic');
    assert.equal(compileOperations(database)[0].result, 'ok');
    assert.equal(count(database, 'knowledge_notes'), 1);
    assert.ok(events.length >= 1, 'X List 直写成功广播 source.compile');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ E. 直写入口：intelligence-wire 缓存时间线 upsertTimelinePost ============

test('WMB-5229 direct-write entry: intelligence wire cached timeline schedules compile', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  try {
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));
    const accountKey = '@wire_account';
    const listId = '1234567890123456789';
    const bound = bindXList(database, {
      accountKey,
      list: { listId, canonicalUrl: `https://x.com/i/lists/${listId}`, ownerHandle: accountKey, name: 'Wire List', kind: 'owned' },
      notify: false
    });
    assert.equal(bound.ok, true);
    const binding = bound.data;
    const postUrl = 'https://x.com/wire_account/status/2';
    writeXListTimelineCache(database, {
      accountKey,
      listId,
      detail: { name: binding.name, canonicalUrl: binding.canonicalUrl },
      posts: [{ url: postUrl, authorHandle: accountKey, displayName: null, avatarUrl: null, text: 'AgentForge v2 正式发布，支持多模型路由。', postedAt: '2026-08-12T00:00:00.000Z' }],
      source: 'live',
      fetchedAt: new Date().toISOString()
    });
    // 生产语义：链接先于保存；wire 更新保存（r1→r2）时已关联 Topic 可见。
    const existing = upsertSource(database, { originalUrl: postUrl, title: 'AgentForge v2 正式发布，支持多模型路由。', summary: 'AgentForge v2 正式发布，支持多模型路由。' });
    const topic = upsertKnowledgeTopic(database, { title: 'Wire 巡检' });
    linkTopic(database, existing.id, topic.id);

    const events = [];
    setDataChangedPublisher((event) => events.push(event));
    try {
      const outcome = await runEnabledXListWire({ database, browserConfig: null, checkpoint: {}, onProgress: () => {} });
      assert.equal(outcome.sourceIds.length, 1, 'wire 缓存路径保存 1 条 Source');
      assert.equal(outcome.sourceIds[0], existing.id, '同一 canonical URL 更新既有 Source');
      await drain();
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      setDataChangedPublisher(null);
    }

    const ops = compileOperations(database);
    assert.equal(ops.length, 1, 'wire 直写 → 已关联 Topic 编译 1 次');
    assert.equal(ops[0].result, 'ok');
    assert.equal(ops[0].beforeRevision, 2);
    assert.equal(count(database, 'knowledge_notes'), 1);
    const compileEvents = events.filter((event) => event.scopes.includes('knowledge') && event.scopes.includes('topics') && event.scopes.includes('receipt'));
    assert.ok(compileEvents.length >= 1, 'wire 直写成功广播 source.compile');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ F. 同 revision：并发去重 + 完成后重放零写 ============

test('WMB-5229 same revision: concurrent dedup then idempotent replay', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  try {
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));
    const source = upsertSource(database, {
      title: 'AgentForge v2 官方公告',
      originalUrl: 'https://news.example/agentforge-replay',
      summary: SOURCE_SUMMARY
    });
    const topic = upsertKnowledgeTopic(database, { title: '重放 Topic' });
    linkTopic(database, source.id, topic.id);
    const input = { sourceId: source.id, revision: source.revision };

    // 并发去重：同一 tick 内两次调度，第二次被丢弃。
    const first = scheduleSourceKnowledgeCompileWith(depsFor(root, modelOf(fenced(goodManifest()))), input);
    const second = scheduleSourceKnowledgeCompileWith(depsFor(root, modelOf(fenced(goodManifest()))), input);
    assert.equal(first, true);
    assert.equal(second, false, '同 revision 在飞 → 并发去重');
    await drain();
    assert.equal(compileOperations(database).length, 1, '只执行一次编译');
    assert.equal(count(database, 'knowledge_update_receipts'), 1);
    const notesAfterFirst = count(database, 'knowledge_notes');
    assert.equal(notesAfterFirst, 1);

    // 完成后同 revision 重放：requestId 幂等 → store 零增量（replay=true，回执不变）。
    const replay = await runSourceKnowledgeCompile(depsFor(root, modelOf(fenced(goodManifest()))), input);
    assert.equal(replay.topics.length, 1);
    assert.equal(replay.topics[0].result, 'ok');
    assert.equal(replay.topics[0].replay, true, '同 revision 重放 → store 幂等 replay');
    assert.equal(count(database, 'knowledge_update_receipts'), 1, '重放零新增回执');
    assert.equal(count(database, 'knowledge_change_sets'), 1, '重放零新增 ChangeSet');
    assert.equal(count(database, 'knowledge_notes'), notesAfterFirst, '重放零新增知识');
    assert.equal(compileOperations(database).length, 2, '重放仍留下可读操作证据');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ G. revision 更新：陈旧在飞编译零写失败证据 + 新 revision 正常编译 ============

test('WMB-5229 revision update: stale in-flight compile fails closed, new revision compiles', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  try {
    setSourceKnowledgeCompileDeps(depsFor(root, modelOf(fenced(goodManifest()))));
    const source = upsertSource(database, {
      title: 'AgentForge v2 官方公告',
      originalUrl: 'https://news.example/agentforge-rev',
      summary: SOURCE_SUMMARY
    });
    const topic = upsertKnowledgeTopic(database, { title: '版本 Topic' });
    linkTopic(database, source.id, topic.id);

    // 调度 r1 编译后、执行前，Source 被更新到 r2 → 编译必须拒绝陈旧提交（零写）。
    const scheduled = scheduleSourceKnowledgeCompileWith(depsFor(root, modelOf(fenced(goodManifest()))), { sourceId: source.id, revision: source.revision });
    assert.equal(scheduled, true);
    upsertSource(database, { originalUrl: 'https://news.example/agentforge-rev', title: 'AgentForge v2 官方公告（更新）' });
    await drain();

    const ops = compileOperations(database);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].result, 'error');
    assert.equal(ops[0].errorCode, 'SOURCE_REVISION_STALE');
    assert.equal(ops[0].beforeRevision, 2, '证据记录实际 revision');
    assert.equal(count(database, 'knowledge_change_sets'), 0, '陈旧编译零写');
    assert.equal(count(database, 'knowledge_update_receipts'), 0);
    assert.equal(count(database, 'knowledge_notes'), 0);

    // 新 revision r2：正常编译，requestId 指向 r2。
    const run2 = await runSourceKnowledgeCompile(depsFor(root, modelOf(fenced(goodManifest()))), { sourceId: source.id, revision: 2 });
    assert.equal(run2.topics.length, 1);
    assert.equal(run2.topics[0].result, 'ok');
    assert.equal(run2.topics[0].requestId, knowledgeCompileTopicRequestId(source.id, 2, topic.id));
    assert.equal(count(database, 'knowledge_update_receipts'), 1);
    assert.equal(count(database, 'knowledge_notes'), 1);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ============ H. 失败隔离：单 Topic 失败不阻断其余 Topic，全部失败零广播 ============

test('WMB-5229 failure isolation: one topic fails, sibling compiles; evidence structured', async () => {
  const root = await makeRoot();
  const { database } = await makeDatabase(root);
  try {
    // 模型按 Topic 分流：Topic B 正常，Topic A 输出非 manifest → PLAN 失败。
    const modelCall = async (prompt) => prompt.includes('Topic B') ? fenced(goodManifest()) : '这不是一个 manifest';
    setSourceKnowledgeCompileDeps(depsFor(root, modelCall));
    const source = upsertSource(database, {
      title: 'AgentForge v2 官方公告',
      originalUrl: 'https://news.example/agentforge-fail',
      summary: SOURCE_SUMMARY
    });
    const topicA = upsertKnowledgeTopic(database, { title: 'Topic A 失败' });
    const topicB = upsertKnowledgeTopic(database, { title: 'Topic B 正常' });
    linkTopic(database, source.id, topicA.id);
    linkTopic(database, source.id, topicB.id);

    const run = await runSourceKnowledgeCompile(depsFor(root, modelCall), { sourceId: source.id, revision: source.revision });
    assert.equal(run.topics.length, 2, '两个已关联 Topic 都被处理');
    const byTopic = Object.fromEntries(run.topics.map((outcome) => [outcome.topicId, outcome]));
    assert.equal(byTopic[topicA.id].result, 'error');
    assert.equal(byTopic[topicA.id].code, 'PLAN:MANIFEST_NOT_FOUND', '结构化失败码 STAGE:CODE');
    assert.equal(byTopic[topicB.id].result, 'ok');

    const ops = compileOperations(database);
    assert.equal(ops.length, 2, '两个 Topic 各留一条可读操作证据');
    const errorOps = ops.filter((op) => op.result === 'error');
    const okOps = ops.filter((op) => op.result === 'ok');
    assert.equal(errorOps.length, 1);
    assert.equal(errorOps[0].errorCode, 'PLAN:MANIFEST_NOT_FOUND');
    assert.equal(okOps.length, 1);
    assert.equal(count(database, 'knowledge_update_receipts'), 1, '仅成功 Topic 落回执');
    assert.equal(count(database, 'knowledge_notes'), 1, '仅成功 Topic 晋升知识');
    assert.equal(run.broadcast, true, '至少一个 Topic 成功 → 广播');

    // 全部失败：零写 + 零广播。
    const modelBad = async () => '依然不是 manifest';
    const runAllBad = await runSourceKnowledgeCompile(depsFor(root, modelBad), { sourceId: source.id, revision: source.revision });
    assert.equal(runAllBad.broadcast, false);
    assert.ok(runAllBad.topics.every((outcome) => outcome.result === 'error'));
    assert.equal(count(database, 'knowledge_update_receipts'), 1, '全失败不新增回执');
    assert.equal(count(database, 'knowledge_notes'), 1, '全失败零新增知识');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
