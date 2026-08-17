// WMB-5301：归档调度器不得因命令派发强制或回放冲突而崩溃。
// 回归覆盖（全部真实 ActiveWorkspaceRuntime + dispatcher）：
// 1. 媒体 worker：用户重试（attempts 归零）后再次执行 → 不抛 REQUEST_REPLAY_CONFLICT、不复用旧生命周期回执；
// 2. 正文 worker：用户重试（attempt_count 归零）后再次执行 → 不抛 REQUEST_REPLAY_CONFLICT；
// 3. 媒体调度器：启动恢复必须经命令调度（不违反 WMB_WRITE_REQUIRES_COMMAND_DISPATCH），
//    且新运行时激活（新 epoch、同工作空间）必须重新执行恢复而不是回放旧回执；
// 4. 正文调度器：启动恢复 requestId 绑定运行时激活，每次启动都真实执行一次恢复。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { insertMediaCandidates, getMediaCandidate } = await import('../src/main/db/media-archive-store.ts');
const { sourceRevisionKey } = await import('../src/shared/media-candidates.ts');
const {
  runDueMediaArchiveJobs,
  claimMediaArchiveJob,
  retryMediaArchiveCandidate,
  MediaArchiveScheduler,
  MEDIA_ARCHIVE_RETRY_COMMAND,
  MEDIA_ARCHIVE_RECOVER_COMMAND,
  MEDIA_ARCHIVE_CLAIM_COMMAND
} = await import('../src/main/media-archive-worker.ts');
const {
  runDueSourceBodyJobs,
  retrySourceBodyCaptureFailures,
  SourceBodyArchiveScheduler,
  sourceBodyJobKey,
  SOURCE_BODY_ARCHIVE_CLAIM_COMMAND
} = await import('../src/main/source-body-archive.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { dispatchBusinessCommand, requireReceiptData } = await import('../src/main/business-command.ts');
const { dispatchSourceUpsertBatch } = await import('../src/main/source-commands.ts');

// ============ fixtures / helpers ============

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const ownerActor = Object.freeze({ type: 'owner_ui', id: 'renderer', label: 'Owner UI' });

function randomUUID() {
  return `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** 建库 + 工作空间身份（runtime 打开前的种子连接，不受写护栏约束）。 */
function makeSeed(root, workspaceId) {
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(workspaceId, now, now);
  return database;
}

function seedSource(database, overrides = {}) {
  const now = new Date().toISOString();
  const id = overrides.id ?? `src-${randomUUID()}`;
  const url = overrides.url ?? `https://example.com/${id}`;
  database.prepare(
    `INSERT INTO source_items (id, feed_id, original_url, canonical_url, content_fingerprint, title, collected_at, categories_json, keywords_json,
      recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, 1)`
  ).run(id, null, url, url, url ? null : `fp-${id}`, overrides.title ?? 't', now, now, now);
  return { id, revision: 1 };
}

async function enqueueImage(database, { sourceId, revKey, url, ordinal = 0, channel = 'research' }) {
  return insertMediaCandidates(database, {
    sourceId,
    sourceRevisionKey: revKey,
    channel,
    requestId: `req-${randomUUID()}`,
    discoveredAt: new Date().toISOString(),
    candidates: [{ kind: 'image', originalUrl: url, ordinal, channel }]
  });
}

function jobIdOf(database, candidateId) {
  return database.prepare('SELECT id FROM jobs WHERE payload_json LIKE ?').get(`%${candidateId}%`).id;
}

/** 模拟 HTTP 服务器：handler(url, method, init) → { status, headers, body } | Response */
function fakeFetch(handler) {
  return async (url, init = {}) => {
    const method = String(init.method ?? 'GET');
    const result = await handler(String(url), method, init);
    if (result instanceof Response) return result;
    const status = result?.status ?? 200;
    const headers = result?.headers ?? {};
    const body = result?.body ?? '';
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.isBuffer(body) ? body : body;
    const response = new Response(bytes, { status, headers });
    if (method === 'HEAD') {
      Object.defineProperty(response, 'body', { value: null, configurable: true });
    }
    return response;
  };
}

/** 媒体抓取：resolveHost → string[]（IP 列表）。 */
const mediaResolveHost = () => async () => ['93.184.216.34'];
/** 正文抓取：lookupImpl → [{ address, family }]。 */
const bodyLookup = () => async () => [{ address: '93.184.216.34', family: 4 }];

const fetch404 = fakeFetch(() => ({ status: 404, headers: {}, body: 'nope' }));
const fetch404Html = fakeFetch(() => ({ status: 404, headers: { 'content-type': 'text/html' }, body: 'missing' }));
const goodImage = fakeFetch(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }));
const goodHtml = fakeFetch(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body><p>可读正文内容。</p></body></html>' }));

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ============ 1. 媒体 worker：重试归零后第二次执行不得回放/冲突 ============

test('WMB-5301 media worker: manual retry resetting attempts does not replay old lifecycle receipts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wmb-5301-media-retry-'));
  let runtime = null;
  try {
    const seed = makeSeed(root, 'ws-5301-media-retry');
    const { id: sourceId, revision } = seedSource(seed);
    const revKey = sourceRevisionKey(sourceId, revision);
    const { candidateIds } = await enqueueImage(seed, { sourceId, revKey, url: 'https://cdn.example.com/5301.png' });
    const candidateId = candidateIds[0];
    const jobId = jobIdOf(seed, candidateId);
    seed.close();

    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5301-media-retry-e1' });
    // 生命周期 1：抓取失败 → job failed（attempts=1）。
    const first = await runDueMediaArchiveJobs(runtime, { deps: { fetchImpl: fetch404, resolveHost: mediaResolveHost() } });
    assert.equal(first.processed, 1);
    assert.equal(getMediaCandidate(runtime.database, candidateId).status, 'failed');

    // 既有重试 API（经 dispatcher 授权）：attempts 归零、回 pending。
    const retryReceipt = await dispatchBusinessCommand(runtime, {
      command: MEDIA_ARCHIVE_RETRY_COMMAND,
      requestId: 'wmb-5301-media-retry-1',
      actor: ownerActor,
      input: { candidateId },
      boundIdentity: runtime.identity,
      entityType: 'media_archive_job',
      execute: (db, value) => {
        const data = retryMediaArchiveCandidate(db, value.candidateId);
        if (!data.ok) throw Object.assign(new Error(data.message), { code: data.code });
        return { data, entityId: value.candidateId };
      }
    });
    assert.equal(retryReceipt.ok, true, JSON.stringify(retryReceipt.error ?? null));
    assert.equal(getMediaCandidate(runtime.database, candidateId).attemptCount, 0);
    assert.equal(runtime.database.prepare('SELECT attempts FROM jobs WHERE id = ?').get(jobId).attempts, 0);

    // 生命周期 2：同 job、同 attempts=0 再次执行 —— 不得复用旧回执（REQUEST_REPLAY_CONFLICT / 陈旧回放）。
    const second = await runDueMediaArchiveJobs(runtime, { deps: { fetchImpl: goodImage, resolveHost: mediaResolveHost() } });
    assert.equal(second.preserved, 1);
    assert.equal(getMediaCandidate(runtime.database, candidateId).status, 'preserved');
    // 两个生命周期各产生一次全新 claim（第二次不是回放）。
    const claims = runtime.database.prepare('SELECT request_id AS requestId FROM command_receipts WHERE command = ? AND request_id LIKE ?')
      .all(MEDIA_ARCHIVE_CLAIM_COMMAND, `media-archive:${jobId}:claim:%`);
    assert.equal(claims.length, 2);
    assert.notEqual(claims[0].requestId, claims[1].requestId);
  } finally {
    if (runtime) await runtime.stop({ drain: false });
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ============ 2. 正文 worker：重试归零后第二次执行不得回放/冲突 ============

test('WMB-5301 source body worker: manual retry resetting attempt_count does not replay old lifecycle receipts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wmb-5301-body-retry-'));
  let runtime = null;
  try {
    const seed = makeSeed(root, 'ws-5301-body-retry');
    seed.close();

    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5301-body-retry-e1' });
    const ingest = await dispatchSourceUpsertBatch(runtime, {
      requestId: 'wmb-5301-body-ingest',
      actor: ownerActor,
      items: [{ title: 'URL来源', originalUrl: 'https://example.com/p' }]
    });
    assert.equal(ingest.ok, true, JSON.stringify(ingest.error ?? null));
    const sourceId = ingest.data.sources[0].id;
    const jobId = runtime.database.prepare('SELECT id FROM source_body_capture_jobs WHERE source_id = ?').get(sourceId).id;

    // 生命周期 1：404 → needs_review（attempt_count=1）。
    const first = await runDueSourceBodyJobs(runtime, { deps: { fetchImpl: fetch404Html, lookupImpl: bodyLookup() } });
    assert.equal(first.processed, 1);
    const afterFirst = runtime.database.prepare('SELECT status, attempt_count AS attempts FROM source_body_capture_jobs WHERE id = ?').get(jobId);
    assert.equal(afterFirst.status, 'needs_review');
    assert.equal(afterFirst.attempts, 1);

    // 既有重试 API（经 dispatcher 授权）：attempt_count 归零、回 pending。
    const retryReceipt = await dispatchBusinessCommand(runtime, {
      command: 'source_body_archive.retry_failures',
      requestId: 'wmb-5301-body-retry-1',
      actor: ownerActor,
      input: { scope: 'selected', jobIds: [jobId] },
      boundIdentity: runtime.identity,
      entityType: 'source_body_capture_job',
      execute: (db, value) => {
        const data = retrySourceBodyCaptureFailures(db, value);
        return { data, readback: data };
      }
    });
    assert.equal(retryReceipt.ok, true, JSON.stringify(retryReceipt.error ?? null));
    assert.equal(requireReceiptData(retryReceipt).retried, 1);
    const afterRetry = runtime.database.prepare('SELECT status, attempt_count AS attempts FROM source_body_capture_jobs WHERE id = ?').get(jobId);
    assert.equal(afterRetry.status, 'pending');
    assert.equal(afterRetry.attempts, 0);

    // 生命周期 2：同 job、同 attempt_count=0 再次执行 —— 不得 REQUEST_REPLAY_CONFLICT。
    const second = await runDueSourceBodyJobs(runtime, { deps: { fetchImpl: goodHtml, lookupImpl: bodyLookup() } });
    assert.equal(second.ready, 1);
    assert.equal(runtime.database.prepare('SELECT status FROM source_body_capture_jobs WHERE id = ?').get(jobId).status, 'ready');
    const claims = runtime.database.prepare('SELECT request_id AS requestId FROM command_receipts WHERE command = ? AND request_id LIKE ?')
      .all(SOURCE_BODY_ARCHIVE_CLAIM_COMMAND, `source-body-archive:${jobId}:claim:%`);
    assert.equal(claims.length, 2);
  } finally {
    if (runtime) await runtime.stop({ drain: false });
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ============ 3. 媒体调度器：恢复经命令调度 + 每运行时激活执行一次 ============

test('WMB-5301 media scheduler: startup recovery dispatches via command and reruns per runtime epoch', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wmb-5301-media-recover-'));
  const workspaceId = 'ws-5301-media-recover';
  let runtime = null;
  let scheduler = null;
  try {
    // 种子：两个"认领后崩溃"的孤儿任务（job running + 候选 downloading，updated_at 回拨 20 分钟）。
    // job B 先保持新鲜 updated_at：epoch-1 恢复只命中 job A；两次激活之间再回拨 B。
    const seed = makeSeed(root, workspaceId);
    const jobIds = {};
    for (const tag of ['a', 'b']) {
      const { id: sourceId, revision } = seedSource(seed, { url: `https://example.com/${tag}` });
      const revKey = sourceRevisionKey(sourceId, revision);
      const { candidateIds } = await enqueueImage(seed, { sourceId, revKey, url: `https://cdn.example.com/${tag}.png` });
      const candidateId = candidateIds[0];
      const jobId = jobIdOf(seed, candidateId);
      jobIds[tag] = jobId;
      const claim = claimMediaArchiveJob(seed, jobId, 0, { requestId: `wmb-5301-crash-${tag}` });
      assert.equal(claim.claimed, true);
      const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      if (tag === 'a') {
        seed.prepare('UPDATE jobs SET updated_at = ?, started_at = ? WHERE id = ?').run(stale, stale, jobId);
      }
    }
    seed.close();

    // 第一次运行时激活（epoch-1）：恢复 job A，且必须经命令调度（直写会被写护栏拒绝）。
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5301-media-recover-e1' });
    scheduler = new MediaArchiveScheduler({ runtime, intervalMs: 60_000, deps: { fetchImpl: fetch404, resolveHost: mediaResolveHost() } });
    scheduler.start();
    await waitUntil(() => runtime.database.prepare('SELECT status FROM jobs WHERE id = ?').get(jobIds.a).status !== 'running', 'media job A recovery (epoch 1)');
    const e1Receipts = runtime.database.prepare('SELECT request_id AS requestId, result_json AS resultJson FROM command_receipts WHERE command = ?')
      .all(MEDIA_ARCHIVE_RECOVER_COMMAND);
    assert.equal(e1Receipts.length, 1, 'epoch-1 应产生恰一条恢复回执');
    assert.ok(e1Receipts[0].requestId.includes('wmb-5301-media-recover-e1'), '恢复回执必须绑定本运行时 epoch');
    assert.equal(JSON.parse(e1Receipts[0].resultJson).recovered, 1, '恢复必须真实执行（经命令调度，非直写）');
    // 未命中 job B（新鲜 updated_at 不在恢复窗口）。
    assert.equal(runtime.database.prepare('SELECT status FROM jobs WHERE id = ?').get(jobIds.b).status, 'running');
    await scheduler.stop();
    await runtime.stop();
    runtime = null;
    scheduler = null;

    // 两次激活之间：把 job B 回拨为陈旧（模拟新一次启动时仍在飞的孤儿）。
    const backdate = migrateDatabase(path.join(root, 'wmb.db'));
    const staleB = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    backdate.prepare('UPDATE jobs SET updated_at = ?, started_at = ? WHERE id = ?').run(staleB, staleB, jobIds.b);
    backdate.close();

    // 第二次运行时激活（新 epoch、同工作空间）：必须重新执行恢复，而不是回放 epoch-1 旧回执。
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5301-media-recover-e2' });
    scheduler = new MediaArchiveScheduler({ runtime, intervalMs: 60_000, deps: { fetchImpl: fetch404, resolveHost: mediaResolveHost() } });
    scheduler.start();
    await waitUntil(() => runtime.database.prepare('SELECT status FROM jobs WHERE id = ?').get(jobIds.b).status !== 'running', 'media job B recovery (epoch 2)');
    const allReceipts = runtime.database.prepare('SELECT request_id AS requestId, runtime_epoch AS runtimeEpoch, result_json AS resultJson FROM command_receipts WHERE command = ? ORDER BY runtime_epoch')
      .all(MEDIA_ARCHIVE_RECOVER_COMMAND);
    assert.equal(allReceipts.length, 2, '每个运行时激活各产生一条恢复回执');
    assert.ok(allReceipts.every((r) => r.requestId.includes(r.runtimeEpoch)), '恢复回执 requestId 必须绑定各自 epoch');
    assert.notEqual(allReceipts[0].requestId, allReceipts[1].requestId);
    assert.equal(JSON.parse(allReceipts[1].resultJson).recovered, 1, 'epoch-2 的恢复必须真实执行（非回放）');
  } finally {
    if (scheduler) await scheduler.stop();
    if (runtime) await runtime.stop({ drain: false });
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ============ 4. 正文调度器：启动恢复 requestId 绑定运行时激活 ============

test('WMB-5301 source body scheduler: startup recovery reruns per runtime epoch instead of replaying old receipt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wmb-5301-body-recover-'));
  const workspaceId = 'ws-5301-body-recover';
  let runtime = null;
  let scheduler = null;
  try {
    // 种子：两个孤儿 running 正文任务（attempt_count=1，updated_at 回拨 20 分钟；job B 先保持新鲜）。
    const seed = makeSeed(root, workspaceId);
    const jobIds = {};
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    for (const tag of ['a', 'b']) {
      const { id: sourceId, revision } = seedSource(seed, { url: `https://example.com/${tag}` });
      const jobId = `body-${tag}`;
      jobIds[tag] = jobId;
      const updatedAt = tag === 'a' ? stale : now;
      seed.prepare(`INSERT INTO source_body_capture_jobs
        (id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts, next_attempt_at,
         url, channel, domain, retryable, fetch_method, started_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'new_source', 'running', 1, 3, ?, ?, 'official_web', 'example.com', 1, 'static_http', ?, ?, ?)`)
        .run(jobId, workspaceId, sourceId, revision, sourceBodyJobKey(sourceId, revision), stale, `https://example.com/${tag}`, stale, now, updatedAt);
      seed.prepare(`INSERT INTO source_body_capture_attempts (id, job_id, attempt_number, status, fetch_method, started_at)
        VALUES (?, ?, 1, 'running', 'static_http', ?)`)
        .run(`att-${tag}`, jobId, stale);
    }
    seed.close();

    // 第一次运行时激活（epoch-1）：恢复 job A。
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5301-body-recover-e1' });
    scheduler = new SourceBodyArchiveScheduler({ runtime, intervalMs: 60_000, deps: { fetchImpl: fetch404Html, lookupImpl: bodyLookup() } });
    scheduler.start();
    await waitUntil(() => runtime.database.prepare('SELECT status FROM source_body_capture_jobs WHERE id = ?').get(jobIds.a).status !== 'running', 'body job A recovery (epoch 1)');
    const e1Receipts = runtime.database.prepare('SELECT request_id AS requestId, result_json AS resultJson FROM command_receipts WHERE command = ?')
      .all('source_body_archive.recover');
    assert.equal(e1Receipts.length, 1, 'epoch-1 应产生恰一条恢复回执');
    assert.ok(e1Receipts[0].requestId.includes('wmb-5301-body-recover-e1'), '恢复回执必须绑定本运行时 epoch');
    assert.equal(JSON.parse(e1Receipts[0].resultJson).recovered, 1);
    assert.equal(runtime.database.prepare('SELECT status FROM source_body_capture_jobs WHERE id = ?').get(jobIds.b).status, 'running');
    await scheduler.stop();
    await runtime.stop();
    runtime = null;
    scheduler = null;

    // 两次激活之间：回拨 job B。
    const backdate = migrateDatabase(path.join(root, 'wmb.db'));
    const staleB = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    backdate.prepare('UPDATE source_body_capture_jobs SET updated_at = ?, started_at = ? WHERE id = ?').run(staleB, staleB, jobIds.b);
    backdate.close();

    // 第二次运行时激活（新 epoch、同工作空间）：恢复必须重新执行，而不是回放旧回执。
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5301-body-recover-e2' });
    scheduler = new SourceBodyArchiveScheduler({ runtime, intervalMs: 60_000, deps: { fetchImpl: fetch404Html, lookupImpl: bodyLookup() } });
    scheduler.start();
    await waitUntil(() => runtime.database.prepare('SELECT status FROM source_body_capture_jobs WHERE id = ?').get(jobIds.b).status !== 'running', 'body job B recovery (epoch 2)');
    const allReceipts = runtime.database.prepare('SELECT request_id AS requestId, runtime_epoch AS runtimeEpoch, result_json AS resultJson FROM command_receipts WHERE command = ? ORDER BY runtime_epoch')
      .all('source_body_archive.recover');
    assert.equal(allReceipts.length, 2, '每个运行时激活各产生一条恢复回执');
    assert.ok(allReceipts.every((r) => r.requestId.includes(r.runtimeEpoch)), '恢复回执 requestId 必须绑定各自 epoch');
    assert.notEqual(allReceipts[0].requestId, allReceipts[1].requestId);
    assert.equal(JSON.parse(allReceipts[1].resultJson).recovered, 1, 'epoch-2 的恢复必须真实执行（非回放）');
  } finally {
    if (scheduler) await scheduler.stop();
    if (runtime) await runtime.stop({ drain: false });
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
