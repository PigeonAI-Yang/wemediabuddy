import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { recordKnowledgeBatch, updateKnowledgeSource, upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const { runKnowledgeBackfillStep } = await import('../src/main/knowledge-backfill.ts');
const {
  KNOWLEDGE_ROUTE_JOB_KIND,
  KNOWLEDGE_COMPILE_JOB_KIND,
  enqueueKnowledgeRouteJob,
  scheduleSourceKnowledgeCompileWith,
  drainSourceKnowledgeCompileQueue,
  drainPersistentKnowledgeJobs,
  recoverAndDrainPersistentKnowledgeJobs,
  getPersistentKnowledgeJobError,
  stopPersistentKnowledgeJobs,
  setSourceKnowledgeCompileDeps
} = await import('../src/main/knowledge-compile-trigger.ts');

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-5358-'));
  const databasePath = path.join(root, 'wmb.db');
  const database = migrateDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)")
    .run(`ws-${randomUUID()}`, now, now);
  const manifest = `\`\`\`json\n${JSON.stringify({ wmb_knowledge_candidates: {
    reason: '持久化知识路由测试',
    topicCompile: { title: '持久化路由 Wiki', summary: '由 Source 编译' },
    entities: [{ entityType: 'product', canonicalKey: 'persistent-router', canonicalName: 'Persistent Router', excerpt: '持久化路由可恢复。', valueRationale: '验证任务生命周期。' }],
    notes: [{ kind: 'claim', canonicalKey: 'persistent-route', statement: '持久化路由可恢复。', conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: '持久化路由可恢复。', valueRationale: '验证任务生命周期。' }]
  } }, null, 2)}\n\`\`\``;
  const routeManifest = `\`\`\`json\n${JSON.stringify({ wmb_knowledge_route: {
    reason: '当前没有可确认的 Topic。', entityCandidates: [], topicCandidates: [],
    selectedEntityKey: null, selectedTopicKey: null, evidenceGaps: []
  } }, null, 2)}\n\`\`\``;
  const deps = { databasePath, openDatabase: migrateDatabase, modelCall: async (prompt) => prompt.includes('wmb_knowledge_route') ? routeManifest : manifest };
  return { root, databasePath, database, deps };
}

function jobs(database) {
  return database.prepare(`SELECT kind,status,attempts,payload_json AS payloadJson,last_error AS lastError
    FROM jobs WHERE kind IN (?,?) ORDER BY kind,dedupe_key`).all(KNOWLEDGE_ROUTE_JOB_KIND, KNOWLEDGE_COMPILE_JOB_KIND);
}

test('WMB-5358 unlinked Source gets a durable resolved routing outcome instead of silent no-op', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '孤立资料', originalUrl: 'https://example.test/orphan-route', summary: '有价值但尚未归属主题。' });
    assert.equal(scheduleSourceKnowledgeCompileWith(state.deps, { sourceId: source.id, revision: source.revision }), true);
    await drainSourceKnowledgeCompileQueue();
    const rows = jobs(state.database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, KNOWLEDGE_ROUTE_JOB_KIND);
    assert.equal(rows[0].status, 'needs_user');
    assert.equal(JSON.parse(rows[0].payloadJson).outcome, 'unresolved');
    assert.equal(rows[0].attempts, 1);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 Topic linked later enqueues one compile job and compiles the unchanged Source revision', async () => {
  const state = await setup();
  try {
    setSourceKnowledgeCompileDeps(state.deps);
    const source = upsertSource(state.database, { title: '后关联资料', originalUrl: 'https://example.test/later-link', summary: 'Source 先入库，Topic 后确认。' });
    scheduleSourceKnowledgeCompileWith(state.deps, { sourceId: source.id, revision: source.revision });
    await drainSourceKnowledgeCompileQueue();

    const first = recordKnowledgeBatch(state.database, { items: [{ sourceId: source.id, topic: { title: '后确认主题' } }] });
    const second = recordKnowledgeBatch(state.database, { items: [{ sourceId: source.id, topic: { title: '后确认主题' } }] });
    assert.equal(first[0].topicId, second[0].topicId);
    await drainPersistentKnowledgeJobs(state.deps);

    const compileRows = jobs(state.database).filter((row) => row.kind === KNOWLEDGE_COMPILE_JOB_KIND);
    assert.equal(compileRows.length, 1, 'dedupe_key 保证同 source revision + topic 只编译一次');
    assert.equal(compileRows[0].status, 'succeeded', compileRows[0].lastError ?? 'compile failed');
    assert.equal(state.database.prepare('SELECT count(*) AS count FROM knowledge_update_receipts').get().count, 1);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 startup recovery reclaims an interrupted persistent compile job', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '重启资料', originalUrl: 'https://example.test/restart', summary: '编译中应用重启。' });
    recordKnowledgeBatch(state.database, { items: [{ sourceId: source.id, topic: { title: '重启主题' } }] });
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    state.database.prepare(`UPDATE jobs SET status='running',attempts=1,started_at=?,updated_at=? WHERE kind=?`)
      .run(staleAt, staleAt, KNOWLEDGE_COMPILE_JOB_KIND);

    await recoverAndDrainPersistentKnowledgeJobs(state.deps);
    const row = jobs(state.database).find((item) => item.kind === KNOWLEDGE_COMPILE_JOB_KIND);
    assert.equal(row.status, 'succeeded', row.lastError ?? 'recovery compile failed');
    assert.equal(row.attempts, 2, '恢复后重新 claim 并保留尝试次数');
    assert.equal(state.database.prepare('SELECT count(*) AS count FROM knowledge_update_receipts').get().count, 1);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 stale persistent compile job is failed and can be replaced by the current revision', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '会变更的资料', originalUrl: 'https://example.test/stale', summary: '旧版本。' });
    const topic = upsertKnowledgeTopic(state.database, { title: '陈旧任务主题' });
    state.database.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(topic.id, source.id, 'primary', new Date().toISOString(), new Date().toISOString());
    assert.equal(enqueueKnowledgeRouteJob(state.database, { sourceId: source.id, revision: source.revision }), true);
    const updated = upsertSource(state.database, { title: '会变更的资料', originalUrl: 'https://example.test/stale', summary: '新版本。' });
    assert.equal(updated.revision, source.revision + 1);
    const oldJob = state.database.prepare('SELECT id FROM jobs WHERE kind=? AND dedupe_key=?').get(
      KNOWLEDGE_ROUTE_JOB_KIND, `knowledge_route:${source.id}:r${source.revision}`
    );
    assert.ok(oldJob);
    await drainPersistentKnowledgeJobs(state.deps);
    const stale = state.database.prepare('SELECT status,last_error,payload_json AS payloadJson FROM jobs WHERE id=?').get(oldJob.id);
    assert.equal(stale.status, 'failed');
    assert.match(stale.last_error, /SOURCE_REVISION_STALE/);
    assert.equal(JSON.parse(stale.payloadJson).outcome, 'stale');
    assert.equal(state.database.prepare('SELECT count(*) AS count FROM knowledge_update_receipts').get().count, 0);

    assert.equal(scheduleSourceKnowledgeCompileWith(state.deps, { sourceId: updated.id, revision: updated.revision }), true);
    await drainSourceKnowledgeCompileQueue();
    const current = state.database.prepare('SELECT status FROM jobs WHERE kind=? AND dedupe_key=?').get(
      KNOWLEDGE_ROUTE_JOB_KIND, `knowledge_route:${source.id}:r${updated.revision}`
    );
    assert.equal(current.status, 'succeeded');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 concurrent recovery does not reclaim a live compile job twice', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '并发恢复资料', originalUrl: 'https://example.test/concurrent-recovery', summary: '并发恢复。' });
    recordKnowledgeBatch(state.database, { items: [{ sourceId: source.id, topic: { title: '并发恢复主题' } }] });
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    state.database.prepare(`UPDATE jobs SET status='running',attempts=1,started_at=?,updated_at=? WHERE kind=?`)
      .run(staleAt, staleAt, KNOWLEDGE_COMPILE_JOB_KIND);
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = { ...state.deps, modelCall: async (prompt) => { calls += 1; await gate; return state.deps.modelCall(prompt); } };
    const first = recoverAndDrainPersistentKnowledgeJobs(deps);
    const second = recoverAndDrainPersistentKnowledgeJobs(deps);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls, 1, 'live job 在 stale threshold 内只能被一个 recovery 继续处理');
    release();
    await Promise.all([first, second]);
    const row = state.database.prepare('SELECT attempts,status FROM jobs WHERE kind=?').get(KNOWLEDGE_COMPILE_JOB_KIND);
    assert.equal(row.attempts, 2);
    assert.equal(row.status, 'succeeded');
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 persistent route respects the per-source topic bound', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '多主题资料', originalUrl: 'https://example.test/topic-bound', summary: '有界路由。' });
    const now = new Date().toISOString();
    for (let i = 0; i < 6; i += 1) {
      const topic = upsertKnowledgeTopic(state.database, { title: `有界主题 ${i}` });
      state.database.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(topic.id, source.id, 'primary', now, now);
    }
    assert.equal(scheduleSourceKnowledgeCompileWith(state.deps, { sourceId: source.id, revision: source.revision }), true);
    await drainSourceKnowledgeCompileQueue();
    const row = state.database.prepare('SELECT count(*) AS count FROM jobs WHERE kind=?').get(KNOWLEDGE_COMPILE_JOB_KIND);
    assert.equal(row.count, 5);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 fire-and-forget startup failure is observed without an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    setSourceKnowledgeCompileDeps({ databasePath: path.join(os.tmpdir(), 'wmb-5358-missing', 'wmb.db'), modelCall: async () => '' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0);
    assert.equal(getPersistentKnowledgeJobError()?.code, 'ERR_SQLITE_ERROR');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    setSourceKnowledgeCompileDeps(null);
  }
});

test('WMB-5358 a Source revision update creates a new durable route job', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '更新资料', originalUrl: 'https://example.test/update', summary: 'revision 1' });
    const updated = updateKnowledgeSource(state.database, { id: source.id, expectedRevision: 1, summary: 'revision 2' }, false);
    assert.equal(updated.revision, 2);
    const row = jobs(state.database).find((item) => item.kind === KNOWLEDGE_ROUTE_JOB_KIND);
    assert.ok(row);
    assert.equal(JSON.parse(row.payloadJson).revision, 2);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 high-value historical Source without Topic is routed instead of silently excluded', async () => {
  const state = await setup();
  try {
    upsertSource(state.database, { title: '高价值孤立历史资料', originalUrl: 'https://example.test/backfill-orphan', summary: '有完整摘要。', priority: 1 });
    const result = await runKnowledgeBackfillStep(state.database, {
      compileSource: async () => { throw new Error('no Topic must not compile'); }
    }, { batchLimit: 10, resume: false });
    assert.equal(result.outcomes[0].status, 'skipped_no_topic');
    assert.equal(result.processed, 1);
    assert.ok(jobs(state.database).some((item) => item.kind === KNOWLEDGE_ROUTE_JOB_KIND));
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 compile job fails closed when its Source→Topic relation disappears before execution', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '移除关系资料', originalUrl: 'https://example.test/link-stale', summary: '关系执行前被移除。' });
    const linked = recordKnowledgeBatch(state.database, { items: [{ sourceId: source.id, topic: { title: '临时关系' } }] });
    state.database.prepare('DELETE FROM topic_source_links WHERE source_id=? AND topic_id=?').run(source.id, linked[0].topicId);
    await drainPersistentKnowledgeJobs(state.deps);
    const row = jobs(state.database).find((item) => item.kind === KNOWLEDGE_COMPILE_JOB_KIND);
    assert.equal(row.status, 'failed');
    assert.match(row.lastError, /TOPIC_SOURCE_LINK_STALE/);
    assert.equal(state.database.prepare('SELECT count(*) AS count FROM knowledge_update_receipts').get().count, 0);
  } finally {
    setSourceKnowledgeCompileDeps(null);
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('WMB-5358 runtime teardown waits for the old-root drain and disables later wakes', async () => {
  const state = await setup();
  try {
    const source = upsertSource(state.database, { title: '切根资料', originalUrl: 'https://example.test/root-switch', summary: '旧根任务必须先收口。' });
    recordKnowledgeBatch(state.database, { items: [{ sourceId: source.id, topic: { title: '切根主题' } }] });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    setSourceKnowledgeCompileDeps({ ...state.deps, modelCall: async (prompt) => { calls += 1; await gate; return state.deps.modelCall(prompt); } });
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    let stopped = false;
    const stopping = stopPersistentKnowledgeJobs().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, 'teardown must not close/switch the old root while its drain is writing');
    release();
    await stopping;
    assert.equal(stopped, true);

    const newer = updateKnowledgeSource(state.database, { id: source.id, expectedRevision: 1, summary: '切根后 revision' }, false);
    assert.equal(newer.revision, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = state.database.prepare(`SELECT status,attempts FROM jobs WHERE kind=? AND payload_json LIKE '%"revision":2%'`).get(KNOWLEDGE_ROUTE_JOB_KIND);
    assert.equal(pending.status, 'pending', 'deps 已解绑，旧根不再被后台 drain 写入');
    assert.equal(pending.attempts, 0);
  } finally {
    await stopPersistentKnowledgeJobs();
    state.database.close();
    await rm(state.root, { recursive: true, force: true });
  }
});
