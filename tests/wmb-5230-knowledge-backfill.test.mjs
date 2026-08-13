// WMB-5230：存量高价值 Raw Source 分批回溯编译（backfill scheduler）聚焦测试。
// 覆盖：selection（信号/弱资料/无 Topic 排除）、checkpoint、resume、budget、idempotency、
// 失败重试、回执去重、调度面（启动接线）。compile callback 为真实可执行管线
// （WMB-5228 候选计划 + WMB-5211 编译器，脚本化模型输出——与 WMB-5229 测试同款注入面）。
// 运行：node --test --test-concurrency=1 tests/wmb-5230-knowledge-backfill.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource } = await import('../src/main/sources.ts');
const { writeSourceBodyCache } = await import('../src/main/source-body-cache.ts');
const { upsertKnowledgeTopic } = await import('../src/main/knowledge.ts');
const { knowledgeCompileTopicRequestId } = await import('../src/main/knowledge-compile-trigger.ts');
const {
  BACKFILL_CHECKPOINT_META_KEY,
  KNOWLEDGE_BACKFILL_COMMAND,
  evaluateBackfillSource,
  scanBackfillSourceRows,
  getKnowledgeBackfillCheckpoint,
  clearKnowledgeBackfillCheckpoint,
  createKnowledgeBackfillCompile,
  runKnowledgeBackfillStep,
  runKnowledgeBackfillBatch,
  setKnowledgeBackfillDeps,
  getKnowledgeBackfillDeps,
  scheduleKnowledgeBackfill,
  drainKnowledgeBackfillQueue,
  knowledgeBackfillInFlight
} = await import('../src/main/knowledge-backfill.ts');

// ============ fixtures / helpers ============

async function makeRoot(prefix = 'wmb-5230-') {
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

const SOURCE_SUMMARY = [
  'AgentForge v2 正式发布，支持多模型路由。',
  '官方定价为每百万 token 0.8 美元。',
  '社区反馈称高峰时段延迟明显上升。'
].join('\n');

/** 按 sourceId 派生确定性 manifest（canonicalKey 唯一 → 多 Source 编译互不冲突）。 */
function manifestFor(sourceId) {
  const tag = `bf-${sourceId.slice(0, 8)}`;
  return {
    wmb_knowledge_candidates: {
      reason: 'fixture 回溯编译测试。',
      topicCompile: { title: '回溯编译 Wiki', summary: '从存量 Source 编译的 Topic Wiki' },
      entities: [
        { entityType: 'product', canonicalKey: tag, canonicalName: `产品${tag}`, excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方产品身份，可独立验证。' }
      ],
      notes: [
        { kind: 'claim', canonicalKey: `${tag}-claim`, statement: `${tag} 支持多模型路由。`, conclusionStatus: 'supported', evidenceLevel: 'corroborated', locator: 'L1', excerpt: 'AgentForge v2 正式发布，支持多模型路由。', valueRationale: '官方发布，可验证。' }
      ]
    }
  };
}

/** 脚本化模型：从 prompt 提取 sourceId 并返回其确定性 manifest；badIds 抛错（模拟模型失败）。 */
function modelOf({ bad = new Set() } = {}) {
  return async (prompt) => {
    const match = /sourceId=([0-9A-Za-z-]+)/.exec(prompt);
    const sourceId = match?.[1];
    if (!sourceId || bad.has(sourceId)) throw new Error('MODEL_CALL_FAILED');
    return fenced(manifestFor(sourceId));
  };
}

function compileDepsFor(root, modelCall) {
  return { databasePath: path.join(root, 'wmb.db'), modelCall, openDatabase: migrateDatabase };
}

function backfillDepsFor(root, modelCall) {
  return {
    databasePath: path.join(root, 'wmb.db'),
    compileSource: createKnowledgeBackfillCompile(compileDepsFor(root, modelCall)),
    openDatabase: migrateDatabase
  };
}

function seedTopic(database, title) {
  return upsertKnowledgeTopic(database, { title });
}

function linkTopic(database, sourceId, topicId) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
    .run(topicId, sourceId, 'primary', now, now);
}

function seedSource(database, input) {
  return upsertSource(database, {
    title: input.title,
    originalUrl: `https://example.com/${input.title}`,
    summary: input.summary === undefined ? SOURCE_SUMMARY : input.summary,
    priority: input.priority,
    verificationStatus: input.verificationStatus ?? 'pending',
    valueJudgment: input.valueJudgment,
    managementStatus: input.managementStatus
  });
}

function seedBodyCache(database, sourceId) {
  const now = new Date().toISOString();
  writeSourceBodyCache(database, {
    sourceId,
    url: `https://example.com/body-${sourceId}`,
    status: 'ready',
    contentType: 'text/plain',
    extractedText: SOURCE_SUMMARY,
    extractedChars: SOURCE_SUMMARY.length,
    errorMessage: null,
    fetchedAt: now,
    updatedAt: now
  });
}

/** 发布内容链：content project → 平台版本 → status='published' 的 publication。 */
function seedPublishedChain(database, { sourceId, published = true, topicId = null }) {
  const now = new Date().toISOString();
  const projectId = `proj-${randomUUID()}`;
  database.prepare('INSERT INTO content_projects (id, topic_id, title, status, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(projectId, topicId, `${projectId}-title`, 'completed', now, now);
  database.prepare('INSERT INTO content_project_sources (project_id, source_id) VALUES (?, ?)').run(projectId, sourceId);
  const contentVersionId = `cv-${randomUUID()}`;
  database.prepare('INSERT INTO content_versions (id, project_id, body, version_number, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(contentVersionId, projectId, '正文', now);
  const platformVersionId = `pv-${randomUUID()}`;
  database.prepare(`INSERT INTO platform_versions (id, project_id, content_version_id, platform, format, title, body, asset_ids_json, created_at, updated_at, revision)
    VALUES (?, ?, ?, 'x', 'post', '标题', '正文', '[]', ?, ?, 1)`)
    .run(platformVersionId, projectId, contentVersionId, now, now);
  // platform_accounts.platform 唯一：共享一个 'x' 账号。
  database.prepare("INSERT INTO platform_accounts (id, platform, account_key, display_name, login_state, created_at, updated_at, revision) VALUES ('acct-x', 'x', '@acct-x', 'X', 'authenticated', ?, ?, 1) ON CONFLICT(platform) DO NOTHING")
    .run(now, now);
  const publicationId = `pub-${randomUUID()}`;
  database.prepare(`INSERT INTO publications (id, platform_version_id, platform_version_revision, platform, account_id, account_key, status,
    prepared_assets_json, prepared_evidence_url, external_url, external_id, published_at, created_at, updated_at, revision)
    VALUES (?, ?, 1, 'x', 'acct-x', '@acct-x', ?, '[]', NULL, ?, ?, ?, ?, ?, 1)`)
    .run(publicationId, platformVersionId, published ? 'published' : 'failed',
      `https://example.com/${publicationId}`, `ext-${publicationId}`, now, now, now);
  return { projectId, publicationId };
}

function count(database, table, where = '', params = []) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).count);
}

function receipts(database) {
  return database.prepare('SELECT request_id AS requestId FROM knowledge_update_receipts ORDER BY request_id').all();
}

function backfillOperations(database) {
  return database.prepare(`SELECT entity_id AS entityId, result, error_code AS errorCode, before_revision AS beforeRevision
    FROM operation_log WHERE command = ? ORDER BY created_at, id`).all(KNOWLEDGE_BACKFILL_COMMAND);
}

function sourceSnapshot(database) {
  return database.prepare('SELECT id, title, summary, priority, verification_status AS verificationStatus, value_judgment AS valueJudgment, revision FROM source_items ORDER BY id').all();
}

function writeRawCheckpoint(database, checkpoint) {
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)")
    .run(BACKFILL_CHECKPOINT_META_KEY, JSON.stringify(checkpoint), now, now);
}

/** 人工回执（模拟 ingest/其它触发已编译同一 (source, revision, topic)）。 */
function seedReceipt(database, { workspaceId, requestId }) {
  const now = new Date().toISOString();
  const changeSetId = `cs-${randomUUID()}`;
  database.prepare(`INSERT INTO knowledge_change_sets
    (id, workspace_id, request_id, input_hash, reason, trigger_source, resolution_mode, created_by, created_at)
    VALUES (?, ?, ?, 'seed', 'seed', 'ingest', 'none', 'background_agent', ?)`)
    .run(changeSetId, workspaceId, requestId, now);
  database.prepare(`INSERT INTO knowledge_update_receipts
    (id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json, affected_topics_json, affected_entities_json,
     affected_methods_json, affected_syntheses_json, wiki_page_versions_json, impact_json, auto_resolutions_json, retained_disputes_json,
     failures_json, created_by, created_at)
    VALUES (?, ?, ?, 'ingest', ?, 'seed', '{}', '[]', '[]', '[]', '[]', '[]', '{}', '[]', '[]', '[]', 'background_agent', ?)`)
    .run(randomUUID(), workspaceId, changeSetId, requestId, now);
}

// ============ A. selection：信号 / 弱资料 / 无 Topic / rejected / archived ============

test('WMB-5230 selection: verified / published / high-value eligible; weak, no-topic, no-signal, rejected excluded', async () => {
  const root = await makeRoot();
  let database;
  try {
    ({ database } = await makeDatabase(root));
    const topic = seedTopic(database, 'AI Agent 工具链');
    const archivedTopic = upsertKnowledgeTopic(database, { title: '已归档主题', status: 'archived' });

    const verified = seedSource(database, { title: 'src-verified', verificationStatus: 'verified' });
    linkTopic(database, verified.id, topic.id);

    const published = seedSource(database, { title: 'src-published' });
    linkTopic(database, published.id, topic.id);
    seedPublishedChain(database, { sourceId: published.id, published: true });

    const publishedFailed = seedSource(database, { title: 'src-published-failed' });
    linkTopic(database, publishedFailed.id, topic.id);
    seedPublishedChain(database, { sourceId: publishedFailed.id, published: false });

    const highValue = seedSource(database, { title: 'src-high-value', priority: 1 });
    linkTopic(database, highValue.id, topic.id);

    const valueJudged = seedSource(database, { title: 'src-value-judged', valueJudgment: '高价值深度材料' });
    linkTopic(database, valueJudged.id, topic.id);

    const bodyCached = seedSource(database, { title: 'src-body-cache', summary: null, verificationStatus: 'verified' });
    linkTopic(database, bodyCached.id, topic.id);
    seedBodyCache(database, bodyCached.id);

    const weak = seedSource(database, { title: 'src-weak', summary: null, verificationStatus: 'verified' });
    linkTopic(database, weak.id, topic.id);

    const noTopic = seedSource(database, { title: 'src-no-topic', verificationStatus: 'verified' });
    linkTopic(database, noTopic.id, archivedTopic.id);

    const noSignal = seedSource(database, { title: 'src-no-signal' });
    linkTopic(database, noSignal.id, topic.id);

    const rejected = seedSource(database, { title: 'src-rejected', priority: 1, verificationStatus: 'rejected' });
    linkTopic(database, rejected.id, topic.id);

    const archived = seedSource(database, { title: 'src-archived', verificationStatus: 'verified', managementStatus: 'archived' });
    linkTopic(database, archived.id, topic.id);

    // 扫描只返回非 archived 行；纯评估逐行判定。
    const rows = scanBackfillSourceRows(database, null, 100);
    const byId = new Map(rows.map((row) => [row.sourceId, row]));
    assert.ok(!byId.has(archived.id), 'archived 资料不出现在扫描中');
    assert.equal(byId.size, 10, '扫描含 10 条非 archived 资料');

    const evalOf = (seed) => evaluateBackfillSource(byId.get(seed.id));

    assert.deepEqual(evalOf(verified).signals, ['verified']);
    assert.equal(evalOf(verified).eligible, true);
    assert.deepEqual(evalOf(published).signals, ['published_content']);
    assert.equal(evalOf(published).eligible, true);
    assert.deepEqual(evalOf(publishedFailed).signals, []);
    assert.equal(evalOf(publishedFailed).eligible, false, '发布失败的内容不构成 published_content 信号');
    assert.deepEqual(evalOf(highValue).signals, ['high_value']);
    assert.deepEqual(evalOf(valueJudged).signals, ['high_value'], 'value_judgment 非空 = 显式高价值状态');
    assert.deepEqual(evalOf(bodyCached).signals, ['verified']);
    assert.equal(evalOf(bodyCached).bodyKind, 'body_cache');

    assert.equal(evalOf(weak).eligible, false);
    assert.equal(evalOf(weak).skipReason, 'weak_material');
    assert.equal(evalOf(noTopic).eligible, false);
    assert.equal(evalOf(noTopic).skipReason, 'no_active_topic', '仅关联 archived Topic = 无活跃 Topic');
    assert.equal(evalOf(noSignal).eligible, false);
    assert.equal(evalOf(noSignal).skipReason, 'no_value_signal');
    assert.equal(evalOf(rejected).eligible, false);
    assert.equal(evalOf(rejected).skipReason, 'rejected');
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

// ============ B. checkpoint：app_meta 读写清 + 新一轮语义 + 工作空间隔离 ============

test('WMB-5230 checkpoint: app_meta round-trip, fresh-run semantics, workspace mismatch guard', async () => {
  const root = await makeRoot();
  let database;
  let workspaceId;
  try {
    ({ database, workspaceId } = await makeDatabase(root));
    const deps = backfillDepsFor(root, modelOf());

    // 空库单步 → completed checkpoint 落 app_meta。
    const first = await runKnowledgeBackfillStep(database, deps, { batchLimit: 5 });
    assert.equal(first.done, true);
    assert.equal(first.processed, 0);
    let checkpoint = getKnowledgeBackfillCheckpoint(database);
    assert.ok(checkpoint, 'checkpoint 已写 app_meta');
    assert.equal(checkpoint.workspaceId, workspaceId);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(checkpoint.schemaVersion, 1);
    assert.equal(checkpoint.cursor, '');
    assert.equal(checkpoint.counts.scanned, 0);

    // 已完成 checkpoint + resume（默认）→ 新一轮（空游标）。
    const topic = seedTopic(database, '回溯主题');
    const source = seedSource(database, { title: 'src-checkpoint', verificationStatus: 'verified' });
    linkTopic(database, source.id, topic.id);
    const second = await runKnowledgeBackfillStep(database, deps, { batchLimit: 5 });
    assert.equal(second.checkpoint.runId !== first.checkpoint.runId, true, '已完成 run 再次运行 = 新一轮');
    assert.equal(second.processed, 1);
    assert.equal(second.checkpoint.status, 'completed');
    assert.equal(count(database, 'knowledge_update_receipts'), 1);

    // 工作空间不匹配 → BACKFILL_WORKSPACE_MISMATCH。
    clearKnowledgeBackfillCheckpoint(database);
    writeRawCheckpoint(database, {
      schemaVersion: 1, runId: 'backfill-other', workspaceId: 'ws-other', cursor: '', pendingRetry: [],
      status: 'running', step: 0,
      counts: { scanned: 0, processed: 0, compiled: 0, skippedExistingReceipt: 0, skippedWeak: 0, skippedNoTopic: 0, skippedNoSignal: 0, failed: 0 },
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null
    });
    await assert.rejects(
      runKnowledgeBackfillStep(database, deps, { batchLimit: 5 }),
      (error) => error.code === 'BACKFILL_WORKSPACE_MISMATCH'
    );

    // clear 幂等。
    assert.equal(clearKnowledgeBackfillCheckpoint(database), true);
    assert.equal(clearKnowledgeBackfillCheckpoint(database), false);
    assert.equal(getKnowledgeBackfillCheckpoint(database), null);
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

// ============ C. 端到端：budget / resume / done / 重跑零新增 / Source 不变 ============

test('WMB-5230 e2e: bounded batch, resumable cursor, idempotent re-run, sources untouched', async () => {
  const root = await makeRoot();
  let database;
  let workspaceId;
  try {
    ({ database, workspaceId } = await makeDatabase(root));
    const deps = backfillDepsFor(root, modelOf());
    const topic = seedTopic(database, '回溯主题');
    const sources = [];
    for (let i = 0; i < 4; i += 1) {
      const source = seedSource(database, { title: `src-e2e-${i}`, verificationStatus: 'verified' });
      linkTopic(database, source.id, topic.id);
      sources.push(source);
    }
    const before = sourceSnapshot(database);
    // 扫描按稳定 sourceId（UUID）排序，与插入顺序无关。
    const ordered = [...sources].sort((a, b) => a.id.localeCompare(b.id));

    // 第 1 步：batchLimit=2 硬上限 → 只处理 2 个 Source。
    const step1 = await runKnowledgeBackfillStep(database, deps, { batchLimit: 2 });
    assert.equal(step1.done, false, '未扫尽 → running');
    assert.equal(step1.processed, 2);
    assert.equal(step1.broadcast, true);
    assert.equal(step1.checkpoint.status, 'running');
    assert.equal(step1.checkpoint.step, 1);
    assert.equal(step1.checkpoint.cursor, ordered[1].id, '游标推进到第二个 Source');
    assert.equal(step1.checkpoint.counts.compiled, 2);
    assert.deepEqual(step1.outcomes.map((o) => o.status), ['compiled', 'compiled']);
    assert.equal(count(database, 'knowledge_update_receipts'), 2);
    assert.equal(count(database, 'knowledge_notes'), 2);

    // 第 2 步：resume 从游标继续（不重不漏）。
    const step2 = await runKnowledgeBackfillStep(database, deps, { batchLimit: 2 });
    assert.equal(step2.done, true);
    assert.equal(step2.processed, 2);
    assert.equal(step2.checkpoint.status, 'completed');
    assert.equal(step2.checkpoint.cursor, ordered[3].id);
    assert.equal(step2.checkpoint.counts.compiled, 4);
    assert.equal(count(database, 'knowledge_update_receipts'), 4);
    assert.equal(count(database, 'knowledge_notes'), 4);
    assert.equal(count(database, 'knowledge_entities'), 4);
    const requestIds = receipts(database).map((row) => row.requestId).sort();
    const expected = sources.flatMap((s) => [knowledgeCompileTopicRequestId(s.id, 1, topic.id)]).sort();
    assert.deepEqual(requestIds, expected, '每个 (source, revision, topic) 恰一条回执');

    // 重跑（新一轮）：全部回执去重 → 零新增、零编译、Source 行不变。
    const redo = await runKnowledgeBackfillStep(database, deps, { batchLimit: 10 });
    assert.equal(redo.done, true);
    assert.equal(redo.processed, 4);
    assert.ok(redo.outcomes.every((o) => o.status === 'skipped_existing_receipt'));
    assert.equal(redo.broadcast, false, '无新增编译 → 不广播');
    assert.equal(redo.checkpoint.counts.skippedExistingReceipt, 4);
    assert.equal(redo.checkpoint.counts.compiled, 0);
    assert.equal(count(database, 'knowledge_update_receipts'), 4, '重跑零新增回执');
    assert.equal(count(database, 'knowledge_notes'), 4, '重跑零新增 Note');
    assert.equal(count(database, 'knowledge_wiki_pages'), 1, 'Wiki 页数量不变');
    assert.equal(redo.checkpoint.workspaceId, workspaceId);
    assert.deepEqual(sourceSnapshot(database), before, '回溯不更改 Source（ID/数量/字段/版本全不变）');
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

// ============ D. 弱资料 E2E：保持 Raw，零编译零回执 ============

test('WMB-5230 weak material: stays raw, zero notes/receipts, does not consume budget', async () => {
  const root = await makeRoot();
  let database;
  try {
    ({ database } = await makeDatabase(root));
    const deps = backfillDepsFor(root, modelOf());
    const topic = seedTopic(database, '回溯主题');
    const weak = seedSource(database, { title: 'src-weak-e2e', summary: null, verificationStatus: 'verified' });
    linkTopic(database, weak.id, topic.id);
    const good = seedSource(database, { title: 'src-good-e2e', verificationStatus: 'verified' });
    linkTopic(database, good.id, topic.id);

    const result = await runKnowledgeBackfillStep(database, deps, { batchLimit: 10 });
    assert.equal(result.done, true);
    assert.equal(result.processed, 1, '弱资料不消耗每轮预算');
    const statuses = Object.fromEntries(result.outcomes.map((o) => [o.sourceId, o.status]));
    assert.equal(statuses[weak.id], 'skipped_weak');
    assert.equal(statuses[good.id], 'compiled');
    assert.equal(count(database, 'knowledge_update_receipts'), 1, '弱资料零回执');
    assert.equal(count(database, 'knowledge_notes'), 1, '弱资料零 Note');
    assert.equal(result.checkpoint.counts.skippedWeak, 1);
    const row = database.prepare('SELECT verification_status AS v, revision FROM source_items WHERE id = ?').get(weak.id);
    assert.deepEqual({ ...row }, { v: 'verified', revision: 1 }, '弱资料保持 Raw（revision 不变）');
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

// ============ E. 失败记录 + 可重试：失败零写、checkpoint.pendingRetry、重试成功 ============

test('WMB-5230 failure: recorded, pendingRetry, retry succeeds without touching other sources', async () => {
  const root = await makeRoot();
  let database;
  try {
    ({ database } = await makeDatabase(root));
    const topic = seedTopic(database, '回溯主题');
    const bad = seedSource(database, { title: 'src-bad-e2e', verificationStatus: 'verified' });
    linkTopic(database, bad.id, topic.id);
    const good = seedSource(database, { title: 'src-good-fail-e2e', verificationStatus: 'verified' });
    linkTopic(database, good.id, topic.id);

    // 第一轮：bad 的模型调用抛错 → PLAN/MODEL 失败；good 正常。
    const depsBad = backfillDepsFor(root, modelOf({ bad: new Set([bad.id]) }));
    const step1 = await runKnowledgeBackfillStep(database, depsBad, { batchLimit: 10 });
    assert.equal(step1.done, false, '有待重试 → 非 completed');
    assert.equal(step1.checkpoint.status, 'running');
    assert.deepEqual(step1.checkpoint.pendingRetry, [bad.id]);
    const ops = backfillOperations(database);
    assert.equal(ops.length, 2, 'good 成功 + bad 失败各一条操作证据');
    const badOp = ops.find((op) => op.entityId === `${bad.id}:${topic.id}`);
    assert.equal(badOp.result, 'error');
    assert.match(badOp.errorCode, /^BACKFILL:PLAN:/);
    assert.equal(count(database, 'knowledge_update_receipts'), 1, '失败零写：只有 good 有回执');
    assert.equal(count(database, 'knowledge_notes'), 1);
    const badSourceRow = database.prepare('SELECT revision FROM source_items WHERE id = ?').get(bad.id);
    assert.equal(badSourceRow.revision, 1, '失败不更改 Source');

    // 第二轮（模型恢复）：pendingRetry 优先重试 → 编译成功，重试队列清空。
    const depsGood = backfillDepsFor(root, modelOf());
    const step2 = await runKnowledgeBackfillStep(database, depsGood, { batchLimit: 10 });
    assert.equal(step2.done, true);
    assert.deepEqual(step2.checkpoint.pendingRetry, []);
    assert.equal(step2.checkpoint.status, 'completed');
    assert.equal(count(database, 'knowledge_update_receipts'), 2, '重试成功后补齐回执');
    assert.equal(count(database, 'knowledge_notes'), 2);
    assert.equal(backfillOperations(database).filter((op) => op.result === 'ok').length, 2);
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

// ============ F. 与已存在 receipt 去重（ingest 已编译的 Source 不再编译） ============

test('WMB-5230 receipt dedup: pre-existing receipt skips source entirely', async () => {
  const root = await makeRoot();
  let database;
  let workspaceId;
  try {
    ({ database, workspaceId } = await makeDatabase(root));
    const deps = backfillDepsFor(root, modelOf());
    const topic = seedTopic(database, '回溯主题');
    const already = seedSource(database, { title: 'src-already', verificationStatus: 'verified' });
    linkTopic(database, already.id, topic.id);
    seedReceipt(database, { workspaceId, requestId: knowledgeCompileTopicRequestId(already.id, 1, topic.id) });

    const fresh = seedSource(database, { title: 'src-fresh-dedup', verificationStatus: 'verified' });
    linkTopic(database, fresh.id, topic.id);

    const result = await runKnowledgeBackfillStep(database, deps, { batchLimit: 10 });
    const statuses = Object.fromEntries(result.outcomes.map((o) => [o.sourceId, o.status]));
    assert.equal(statuses[already.id], 'skipped_existing_receipt', '已有回执 → 跳过（零模型调用语义）');
    assert.equal(statuses[fresh.id], 'compiled');
    assert.equal(count(database, 'knowledge_update_receipts'), 2, '无新增重复回执');
    assert.equal(count(database, 'knowledge_notes'), 1, '仅 fresh 产生 Note');
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

// ============ G. 调度面：全局 deps + runKnowledgeBackfillBatch + drain + teardown ============

test('WMB-5230 scheduler surface: set deps, bounded startup batch, drain, teardown', async () => {
  const root = await makeRoot();
  let database;
  try {
    ({ database } = await makeDatabase(root));
    database.close();
    const topicRow = migrateDatabase(path.join(root, 'wmb.db'));
    const topic = seedTopic(topicRow, '回溯主题');
    const source = seedSource(topicRow, { title: 'src-schedule', verificationStatus: 'verified' });
    linkTopic(topicRow, source.id, topic.id);
    topicRow.close();

    setKnowledgeBackfillDeps(backfillDepsFor(root, modelOf()));
    try {
      assert.equal(getKnowledgeBackfillDeps() !== null, true);
      assert.equal(scheduleKnowledgeBackfill(), true, '启动调度 → 有界单批');
      await drainKnowledgeBackfillQueue();
      assert.equal(knowledgeBackfillInFlight(), 0);

      const database2 = migrateDatabase(path.join(root, 'wmb.db'));
      try {
        const checkpoint = getKnowledgeBackfillCheckpoint(database2);
        assert.ok(checkpoint && checkpoint.status === 'completed');
        assert.equal(checkpoint.counts.compiled, 1);
        assert.equal(count(database2, 'knowledge_update_receipts'), 1);
      } finally {
        database2.close();
      }

      // 无 deps 时不调度；显式 runKnowledgeBackfillBatch 抛 DEP 未注册。
      setKnowledgeBackfillDeps(null);
      assert.equal(scheduleKnowledgeBackfill(), false);
      await assert.rejects(runKnowledgeBackfillBatch(), (error) => error.code === 'BACKFILL_DEPS_NOT_REGISTERED');
    } finally {
      setKnowledgeBackfillDeps(null);
      await drainKnowledgeBackfillQueue();
    }
  } finally {
    try { database?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
