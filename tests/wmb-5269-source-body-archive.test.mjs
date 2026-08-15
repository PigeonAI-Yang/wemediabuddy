// WMB-5269（Source 正文自动归档）聚焦测试。
// 覆盖：migration 71 表/索引/唯一约束/水位元数据；结构化全文立即固化 + 幂等 job；
// URL-only pending；无正文来源终态 unavailable；claim/finish 成功路径与 attempt 收据；
// 可重试失败退避 + 三次尝试终态 needs_review；Retry-After 退避交互；不可重试
// security/auth/http/content 行为；孤儿 running 恢复；历史补抓 keyset 分页/去重/
// archived+已有 ready 排除；重试 selected/reason/all 资格与 attempts 历史保留；
// 失败读模型分页 keyset 与分类过滤；生产入口 dispatchSourceUpsertBatch 调度正文任务
// + runDueSourceBodyJobs 经 dispatcher 处理到期任务。
// 运行：node --test tests/wmb-5269-source-body-archive.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { migrateDatabase } = await import('../src/main/db/migrations.ts');
const { upsertSource, createSourceFeed } = await import('../src/main/sources.ts');
const { writeSourceBodyCache, getSourceBodyCache } = await import('../src/main/source-body-cache.ts');
const { ActiveWorkspaceRuntime } = await import('../src/main/workspace-runtime.ts');
const { dispatchSourceUpsertBatch } = await import('../src/main/source-commands.ts');
const {
  scheduleSourceBodyArchive,
  claimSourceBodyJob,
  finishSourceBodyJob,
  executeSourceBodyCapture,
  recoverInterruptedSourceBodyJobs,
  runSourceBodyBackfillPage,
  listSourceBodyCaptureFailures,
  listSourceBodyCaptureAttempts,
  retrySourceBodyCaptureFailures,
  runDueSourceBodyJobs,
  sourceBodyJobKey,
  isSourceBodyArchivePaused,
  setSourceBodyArchivePaused,
  SOURCE_BODY_MAX_ATTEMPTS,
  SOURCE_BODY_STALE_RUNNING_MS
} = await import('../src/main/source-body-archive.ts');

// ============ fixtures / helpers ============

function randomUUID() {
  return `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function makeDatabase(prefix = 'wmb-5269-') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(root, 'wmb.db');
  const database = migrateDatabase(dbPath);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
    .run(`ws-${randomUUID()}`, now, now);
  return { database, root, dbPath };
}

function seedSource(database, title = 't', url = `https://example.com/${randomUUID()}`, overrides = {}) {
  const now = new Date().toISOString();
  const id = overrides.id ?? `src-${randomUUID()}`;
  database.prepare(
    `INSERT INTO source_items (id, feed_id, original_url, canonical_url, content_fingerprint, title, collected_at, categories_json, keywords_json,
      recommended_platforms_json, recommended_formats_json, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, 1)`
  ).run(id, overrides.feedId ?? null, url ?? null, url ?? null, url ? null : `fp-${id}`, title, overrides.collectedAt ?? now, now, now);
  return { id, revision: 1 };
}

/** 模拟 HTTP 服务器：handler(url, method) → { status, headers, body } | 抛错（带 code） */
function fakeFetch(handler) {
  return async (url, init = {}) => {
    const method = String(init.method ?? 'GET');
    const result = await handler(String(url), method, init);
    if (result instanceof Response) return result;
    const status = result?.status ?? 200;
    const headers = result?.headers ?? {};
    const body = result?.body ?? '';
    return new Response(body, { status, headers });
  };
}

function resolveHost(ipMap = {}) {
  return async (hostname) => ipMap[hostname] ?? [{ address: '93.184.216.34', family: 4 }];
}

const fetch500 = fakeFetch(() => ({ status: 500, headers: { 'content-type': 'text/html' }, body: 'server down' }));
const fetch404 = fakeFetch(() => ({ status: 404, headers: { 'content-type': 'text/html' }, body: 'missing' }));
const fetch401 = fakeFetch(() => ({ status: 401, headers: { 'content-type': 'text/html' }, body: 'unauthorized' }));
const goodHtml = fakeFetch(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body><p>可读正文内容。</p></body></html>' }));

function jobRow(database, jobId) {
  return database.prepare(`SELECT id, workspace_id AS workspaceId, source_id AS sourceId, source_revision AS sourceRevision,
    job_key AS jobKey, priority, status, attempt_count AS attemptCount, max_attempts AS maxAttempts,
    next_attempt_at AS nextAttemptAt, url, channel, domain, last_error_code AS lastErrorCode,
    last_error_message AS lastErrorMessage, last_http_status AS lastHttpStatus, reason_category AS reasonCategory,
    retryable, fetch_method AS fetchMethod, body_candidate AS bodyCandidate, started_at AS startedAt,
    finished_at AS finishedAt, created_at AS createdAt, updated_at AS updatedAt
    FROM source_body_capture_jobs WHERE id = ?`).get(jobId);
}

function attemptRows(database, jobId) {
  return database.prepare(`SELECT attempt_number AS attemptNumber, status, error_code AS errorCode, error_message AS errorMessage,
    http_status AS httpStatus, fetch_method AS fetchMethod, extracted_chars AS extractedChars,
    started_at AS startedAt, finished_at AS finishedAt
    FROM source_body_capture_attempts WHERE job_id = ? ORDER BY attempt_number`).all(jobId);
}

function countJobs(database) {
  return Number(database.prepare('SELECT COUNT(*) AS n FROM source_body_capture_jobs').get().n);
}

function backfillCursorValue(database) {
  return database.prepare("SELECT value FROM app_meta WHERE key = 'source_body_backfill_cursor'").get().value;
}

/** 反复 claim→失败→finish，直到终态；now 随 attempt 递增以保证退避到期。 */
async function failJobToTerminal(database, jobId, fetchImpl, lookupImpl) {
  let expectedAttempts = 0;
  let lastStatus = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const now = new Date(Date.now() + attempts * 3_600_000).toISOString();
    const claim = claimSourceBodyJob(database, jobId, expectedAttempts, { now });
    assert.equal(claim.claimed, true, `claim #${attempts} 应成功`);
    const outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl, lookupImpl });
    const finish = finishSourceBodyJob(database, { jobId, expectedAttempts: claim.attemptNumber, outcome, now });
    assert.equal(finish.finished, true);
    lastStatus = finish.jobStatus;
    if (lastStatus === 'needs_review' || lastStatus === 'unavailable') return { status: lastStatus, attempts: claim.attemptNumber };
    expectedAttempts = claim.attemptNumber;
  }
}

async function succeedJob(database, jobId, fetchImpl, lookupImpl) {
  const now = new Date(Date.now() + 60_000).toISOString();
  const claim = claimSourceBodyJob(database, jobId, 0, { now });
  assert.equal(claim.claimed, true);
  const outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl, lookupImpl });
  const finish = finishSourceBodyJob(database, { jobId, expectedAttempts: claim.attemptNumber, outcome, now });
  assert.equal(finish.jobStatus, 'ready');
  return { claim, outcome, finish };
}

async function seedTerminalFailures(database, spec) {
  const created = [];
  for (const s of spec) {
    const source = seedSource(database, s.title, s.url);
    if (s.kind === 'no_source') {
      const res = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1 });
      assert.equal(res.status, 'unavailable');
      created.push({ jobId: res.jobId, ...s });
      continue;
    }
    const res = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: s.url });
    assert.equal(res.status, 'pending');
    const outcome = await failJobToTerminal(database, res.jobId, s.fetch, resolveHost());
    created.push({ jobId: res.jobId, ...s, status: outcome.status });
  }
  return created;
}

function seedReadyRevision(database, sourceId, text = '已有正文基线。') {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO source_body_revisions (
    id, source_id, url, status, content_type, extracted_text, extracted_chars, body_hash, error_message, fetched_at, created_at, previous_revision_id
  ) VALUES (?, ?, ?, 'ready', 'text/plain', ?, ?, ?, NULL, ?, ?, NULL)`)
    .run(`rev-${randomUUID()}`, sourceId, 'https://example.com/ready', text, text.length, sha256(text), now, now);
}

// ============ A. migration 71：表/索引/约束/水位 ============

test('WMB-5269 migration 71: jobs/attempts tables, indexes, unique attempt, watermark, idempotent reopen', () => {
  const { database, dbPath } = makeDatabase();
  try {
    const applied = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
    assert.ok(applied.includes(71), 'migration 71 应已应用');

    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    assert.ok(tables.has('source_body_capture_jobs'), 'jobs 表应存在');
    assert.ok(tables.has('source_body_capture_attempts'), 'attempts 表应存在');

    const jobColumns = database.prepare('PRAGMA table_info(source_body_capture_jobs)').all().map((r) => r.name);
    for (const col of ['id', 'workspace_id', 'source_id', 'source_revision', 'job_key', 'priority', 'status',
      'attempt_count', 'max_attempts', 'next_attempt_at', 'body_candidate', 'url', 'channel', 'domain',
      'last_error_code', 'last_error_message', 'last_http_status', 'reason_category', 'retryable', 'fetch_method',
      'started_at', 'finished_at', 'created_at', 'updated_at']) {
      assert.ok(jobColumns.includes(col), `jobs 表应有列 ${col}`);
    }

    const indexes = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('source_body_capture_jobs', 'source_body_capture_attempts')"
    ).all().map((r) => r.name));
    assert.ok(indexes.has('source_body_capture_jobs_queue'), '队列索引应存在');
    assert.ok(indexes.has('source_body_capture_jobs_source'), 'source 索引应存在');
    assert.ok(indexes.has('source_body_capture_jobs_failures'), '失败读模型索引应存在');
    assert.ok(indexes.has('source_body_capture_attempts_job'), 'attempts 索引应存在');

    const attemptsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_body_capture_attempts'").get().sql;
    assert.match(attemptsSql, /UNIQUE \(job_id, attempt_number\)/, '同 job 同 attempt_number 必须唯一');
    const jobsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_body_capture_jobs'").get().sql;
    assert.match(jobsSql, /REFERENCES source_items\(id\) ON DELETE CASCADE/, 'jobs.source_id 应级联删除');

    const source = seedSource(database, '迁移约束', 'https://example.com/mig');
    const base = '2026-08-15T00:00:00.000Z';
    // CHECK：非法状态 / 非法优先级被拒。
    assert.throws(() => database.prepare(`INSERT INTO source_body_capture_jobs
      (id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, 'ws', ?, 1, 'k-bad-status', 'new_source', 'bogus', 0, 3, ?, ?, ?)`).run(randomUUID(), source.id, base, base, base), /CHECK/);
    assert.throws(() => database.prepare(`INSERT INTO source_body_capture_jobs
      (id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, 'ws', ?, 1, 'k-bad-prio', 'bogus', 'pending', 0, 3, ?, ?, ?)`).run(randomUUID(), source.id, base, base, base), /CHECK/);
    // FK：job 引用不存在的 source 被拒。
    assert.throws(() => database.prepare(`INSERT INTO source_body_capture_jobs
      (id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, 'ws', 'missing-source', 1, 'k-bad-fk', 'new_source', 'pending', 0, 3, ?, ?, ?)`).run(randomUUID(), base, base, base), /FOREIGN KEY/);

    // 历史补抓水位缺省 not_started。
    assert.equal(backfillCursorValue(database), 'not_started');

    // attempts 级联：删除 job → attempts 一并删除。
    const jobId = randomUUID();
    database.prepare(`INSERT INTO source_body_capture_jobs
      (id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, 'ws', ?, 1, ?, 'new_source', 'pending', 0, 3, ?, ?, ?)`).run(jobId, source.id, `k-${jobId}`, base, base, base);
    database.prepare(`INSERT INTO source_body_capture_attempts (id, job_id, attempt_number, status, fetch_method, started_at)
      VALUES (?, ?, 1, 'running', 'static_http', ?)`).run(randomUUID(), jobId, base);
    database.prepare('DELETE FROM source_body_capture_jobs WHERE id = ?').run(jobId);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM source_body_capture_attempts WHERE job_id = ?').get(jobId).n, 0);

    // 重开数据库：迁移幂等（版本不重复应用、水位不重置）。
    database.close();
    const reopened = migrateDatabase(dbPath);
    try {
      assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 71').get().n, 1);
      assert.equal(backfillCursorValue(reopened), 'not_started');
    } finally {
      reopened.close();
    }
  } finally {
    try { database.close(); } catch { /* 已在重开前关闭 */ }
  }
});

// ============ B. 结构化全文：立即 ready 缓存 + 幂等 job ============

test('WMB-5269 structured full text: immediate ready cache + ready job, idempotent replay and cross-revision reuse', () => {
  const { database } = makeDatabase();
  try {
    const source = seedSource(database, '结构化正文源', 'https://example.com/s1');
    const text = '这是一段完整的渠道正文。';
    const first = scheduleSourceBodyArchive(database, {
      sourceId: source.id, sourceRevision: 1,
      url: 'https://example.com/s1', structuredText: text,
      contentType: 'text/plain', origin: 'test_channel', channel: 'research'
    });
    assert.equal(first.status, 'ready');
    assert.equal(first.created, true);
    assert.ok(first.jobId);

    const cache = getSourceBodyCache(database, source.id);
    assert.equal(cache.status, 'ready');
    assert.equal(cache.extractedText, text);
    assert.equal(cache.extractedChars, text.length);
    assert.equal(cache.url, 'https://example.com/s1');

    const job = jobRow(database, first.jobId);
    assert.equal(job.status, 'ready');
    assert.equal(job.fetchMethod, 'channel_text');
    assert.equal(job.priority, 'new_source');
    assert.equal(job.attemptCount, 0);
    assert.equal(job.maxAttempts, SOURCE_BODY_MAX_ATTEMPTS);
    assert.equal(job.channel, 'research');
    assert.equal(job.domain, 'example.com');
    assert.equal(job.lastErrorCode, null);
    assert.equal(sourceBodyJobKey(source.id, 1), `source:${source.id}:r1`);

    // 幂等重放：同一 job，不再创建。
    const replay = scheduleSourceBodyArchive(database, {
      sourceId: source.id, sourceRevision: 1,
      url: 'https://example.com/s1', structuredText: text,
      contentType: 'text/plain', origin: 'test_channel', channel: 'research'
    });
    assert.equal(replay.created, false);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.status, 'ready');
    assert.equal(countJobs(database), 1);

    // 跨 revision 同 URL：复用既有 job（防 revision 递增造成抓取风暴），正文投影刷新。
    const nextRev = scheduleSourceBodyArchive(database, {
      sourceId: source.id, sourceRevision: 2,
      url: 'https://example.com/s1', structuredText: '修订后的渠道正文。',
      contentType: 'text/plain', origin: 'test_channel', channel: 'research'
    });
    assert.equal(nextRev.jobId, first.jobId);
    assert.equal(nextRev.created, false);
    assert.equal(countJobs(database), 1);
    assert.equal(getSourceBodyCache(database, source.id).extractedText, '修订后的渠道正文。');

    // 无 URL 的结构化文本同样立即固化。
    const bareSource = seedSource(database, '无链接源', null);
    const bare = scheduleSourceBodyArchive(database, { sourceId: bareSource.id, sourceRevision: 1, structuredText: '无链接正文。' });
    assert.equal(bare.status, 'ready');
    assert.equal(bare.created, true);
    assert.equal(getSourceBodyCache(database, bareSource.id).status, 'ready');
  } finally {
    database.close();
  }
});

// ============ C. URL-only：pending 任务 ============

test('WMB-5269 URL-only: pending job, replay idempotent, cross-revision reuse, ready-cache short-circuit', () => {
  const { database } = makeDatabase();
  try {
    const source = seedSource(database, '链接源', 'https://example.com/u1');
    const first = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: 'https://example.com/u1', channel: 'official_web' });
    assert.equal(first.status, 'pending');
    assert.equal(first.created, true);
    assert.ok(first.jobId);

    const job = jobRow(database, first.jobId);
    assert.equal(job.status, 'pending');
    assert.equal(job.fetchMethod, 'static_http');
    assert.equal(job.priority, 'new_source');
    assert.equal(job.attemptCount, 0);
    assert.equal(job.channel, 'official_web');
    assert.equal(job.domain, 'example.com');
    assert.equal(job.bodyCandidate, null);
    assert.equal(getSourceBodyCache(database, source.id), null, 'URL-only 不立即写正文缓存');

    const replay = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: 'https://example.com/u1' });
    assert.equal(replay.created, false);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(countJobs(database), 1);

    // 跨 revision 同 URL 复用。
    upsertSource(database, { title: '链接源', originalUrl: 'https://example.com/u1' }, false);
    const nextRev = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 2, url: 'https://example.com/u1' });
    assert.equal(nextRev.jobId, first.jobId);
    assert.equal(nextRev.created, false);
    assert.equal(countJobs(database), 1);

    // 已有 ready 正文且 URL 相同 → 不创建任务（jobId null，status ready）。
    const ready = seedSource(database, '已有正文', 'https://example.com/u2');
    const now = new Date().toISOString();
    writeSourceBodyCache(database, {
      sourceId: ready.id, url: 'https://example.com/u2', status: 'ready', contentType: 'text/html',
      extractedText: '已有正文。', extractedChars: 5, errorMessage: null, fetchedAt: now, updatedAt: now
    });
    const shortCircuit = scheduleSourceBodyArchive(database, { sourceId: ready.id, sourceRevision: 1, url: 'https://example.com/u2' });
    assert.equal(shortCircuit.jobId, null);
    assert.equal(shortCircuit.status, 'ready');
    assert.equal(shortCircuit.created, false);
    assert.equal(countJobs(database), 1);

    // 无法 canonicalize 的 URL → 视为缺源（终态 unavailable）。
    const bad = seedSource(database, '坏链接', 'https://example.com/bad');
    const invalid = scheduleSourceBodyArchive(database, { sourceId: bad.id, sourceRevision: 1, url: 'http://[bad-url' });
    assert.equal(invalid.status, 'unavailable');
  } finally {
    database.close();
  }
});

// ============ D. 无正文来源：终态 unavailable ============

test('WMB-5269 no body source: terminal unavailable NO_BODY_SOURCE, nonretryable, idempotent, in failure read model', () => {
  const { database } = makeDatabase();
  try {
    const source = seedSource(database, '无正文来源', 'https://example.com/none');
    const first = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, channel: 'research' });
    assert.equal(first.status, 'unavailable');
    assert.equal(first.created, true);
    assert.ok(first.jobId);

    const job = jobRow(database, first.jobId);
    assert.equal(job.status, 'unavailable');
    assert.equal(job.lastErrorCode, 'NO_BODY_SOURCE');
    assert.equal(job.reasonCategory, 'no_source');
    assert.equal(job.retryable, 0);
    assert.equal(job.fetchMethod, 'none');
    assert.equal(job.url, null);
    assert.equal(job.attemptCount, 0);

    // 同 key 重放：保持终态，不新造任务。
    const replay = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1 });
    assert.equal(replay.created, false);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.status, 'unavailable');
    assert.equal(countJobs(database), 1);

    // 出现在失败读模型（no_source 分类）。
    const list = listSourceBodyCaptureFailures(database, {});
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].jobId, first.jobId);
    assert.equal(list.items[0].reasonCategory, 'no_source');
    assert.equal(list.items[0].retryable, false);
  } finally {
    database.close();
  }
});

// ============ E. 成功路径：claim → 抓取 → finish ============

test('WMB-5269 success: claim writes running attempt, finish writes ready cache + succeeded attempt receipt', async () => {
  const { database } = makeDatabase();
  try {
    const source = seedSource(database, '成功源', 'https://example.com/ok');
    const { jobId } = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: 'https://example.com/ok' });
    const now = new Date(Date.now() + 60_000).toISOString();

    const claim = claimSourceBodyJob(database, jobId, 0, { now });
    assert.equal(claim.claimed, true);
    assert.equal(claim.attemptNumber, 1);
    assert.equal(claim.job.status, 'running');
    assert.equal(claim.job.attemptCount, 1);
    assert.equal(claim.job.startedAt, now);

    let rows = attemptRows(database, jobId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attemptNumber, 1);
    assert.equal(rows[0].status, 'running');
    assert.equal(rows[0].fetchMethod, 'static_http');

    // 乐观锁：同 expectedAttempts 重复 claim → STALE。
    const double = claimSourceBodyJob(database, jobId, 0, { now });
    assert.equal(double.claimed, false);
    assert.equal(double.reason, 'STALE');

    const outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl: goodHtml, lookupImpl: resolveHost() });
    assert.equal(outcome.outcome, 'ready');
    assert.equal(outcome.fetchMethod, 'static_http');
    assert.equal(outcome.hops.length, 1);
    assert.ok(outcome.record.extractedText.includes('可读正文内容'));

    const finish = finishSourceBodyJob(database, { jobId, expectedAttempts: 1, outcome, now });
    assert.deepEqual(finish, { finished: true, stale: false, jobStatus: 'ready' });

    const job = jobRow(database, jobId);
    assert.equal(job.status, 'ready');
    assert.equal(job.fetchMethod, 'static_http');
    assert.equal(job.lastErrorCode, null);
    assert.equal(job.finishedAt, now);
    assert.equal(job.startedAt, null);

    const cache = getSourceBodyCache(database, source.id);
    assert.equal(cache.status, 'ready');
    assert.ok(cache.extractedText.includes('可读正文内容'));
    assert.equal(cache.extractedChars, cache.extractedText.length);

    rows = attemptRows(database, jobId);
    assert.equal(rows[0].status, 'succeeded');
    assert.equal(rows[0].extractedChars, cache.extractedChars);
    assert.equal(rows[0].httpStatus, null, '成功 attempt 不记录 http_status（诊断字段留给失败行）');
    assert.equal(rows[0].finishedAt, now);

    // 已 ready 的 job：重复 finish → stale；重复 claim → STALE。
    const stale = finishSourceBodyJob(database, { jobId, expectedAttempts: 1, outcome, now });
    assert.equal(stale.finished, false);
    assert.equal(stale.stale, true);
    const again = claimSourceBodyJob(database, jobId, 1, { now });
    assert.equal(again.claimed, false);

    // attempt 时间线（读模型）。
    const timeline = listSourceBodyCaptureAttempts(database, jobId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].attempt, 1);
    assert.equal(timeline[0].fetchMethod, 'static_http');
    assert.equal(timeline[0].extractedChars, cache.extractedChars);
    assert.equal(timeline[0].finalUrl, 'https://example.com/ok');
  } finally {
    database.close();
  }
});

// ============ F. 可重试失败：退避重排 + 三次尝试终态 needs_review ============

test('WMB-5269 retryable failure: backoff reschedule twice then terminal needs_review after 3 attempts', async () => {
  const { database } = makeDatabase();
  try {
    const source = seedSource(database, '重试源', 'https://example.com/retry');
    const { jobId } = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: 'https://example.com/retry' });
    const t0 = new Date(Date.now() + 60_000).toISOString();

    // 第 1 次：失败 → retry_wait + 退避（attempt 1 基值 2 分钟 × 抖动 0.8~1.2）。
    let claim = claimSourceBodyJob(database, jobId, 0, { now: t0 });
    assert.equal(claim.claimed, true);
    assert.equal(claim.attemptNumber, 1);
    let outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl: fetch500, lookupImpl: resolveHost() });
    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.code, 'NETWORK_ERROR');
    assert.equal(outcome.retryable, true);
    let finish = finishSourceBodyJob(database, { jobId, expectedAttempts: 1, outcome, now: t0 });
    assert.equal(finish.jobStatus, 'retry_wait');

    let job = jobRow(database, jobId);
    assert.equal(job.status, 'retry_wait');
    assert.equal(job.lastErrorCode, 'NETWORK_ERROR');
    assert.equal(job.lastHttpStatus, 500);
    assert.equal(job.reasonCategory, 'network');
    assert.equal(job.retryable, 1);
    const delay1 = Date.parse(job.nextAttemptAt) - Date.parse(t0);
    assert.ok(delay1 >= 95_999 && delay1 <= 144_001, `attempt 1 退避应在 [96s, 144s]，实际 ${delay1}ms`);

    // 未到期 claim → STALE。
    const early = claimSourceBodyJob(database, jobId, 1, { now: t0 });
    assert.equal(early.claimed, false);

    // 第 2 次（退避到期后）：仍 retry_wait，attempt 2 退避基值 16 分钟。
    const t1 = new Date(Date.parse(t0) + 10 * 60_000).toISOString();
    claim = claimSourceBodyJob(database, jobId, 1, { now: t1 });
    assert.equal(claim.claimed, true);
    assert.equal(claim.attemptNumber, 2);
    outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl: fetch500, lookupImpl: resolveHost() });
    finish = finishSourceBodyJob(database, { jobId, expectedAttempts: 2, outcome, now: t1 });
    assert.equal(finish.jobStatus, 'retry_wait');
    job = jobRow(database, jobId);
    assert.equal(job.attemptCount, 2);
    const delay2 = Date.parse(job.nextAttemptAt) - Date.parse(t1);
    assert.ok(delay2 >= 767_999 && delay2 <= 1_152_001, `attempt 2 退避应在 [768s, 1152s]，实际 ${delay2}ms`);

    // 第 3 次：耗尽 → 终态 needs_review（不再自动重试）。
    const t2 = new Date(Date.parse(t0) + 40 * 60_000).toISOString();
    claim = claimSourceBodyJob(database, jobId, 2, { now: t2 });
    assert.equal(claim.claimed, true);
    assert.equal(claim.attemptNumber, 3);
    outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl: fetch500, lookupImpl: resolveHost() });
    finish = finishSourceBodyJob(database, { jobId, expectedAttempts: 3, outcome, now: t2 });
    assert.equal(finish.jobStatus, 'needs_review');

    job = jobRow(database, jobId);
    assert.equal(job.status, 'needs_review');
    assert.equal(job.attemptCount, SOURCE_BODY_MAX_ATTEMPTS);
    assert.equal(job.retryable, 1);
    assert.equal(job.reasonCategory, 'network');
    assert.equal(job.finishedAt, t2);

    // 终态后 claim → STALE。
    const after = claimSourceBodyJob(database, jobId, 3, { now: t2 });
    assert.equal(after.claimed, false);

    // 三次尝试时间线保留。
    const timeline = listSourceBodyCaptureAttempts(database, jobId);
    assert.equal(timeline.length, 3);
    assert.deepEqual(timeline.map((a) => a.attempt), [1, 2, 3]);
    for (const a of timeline) {
      assert.equal(a.errorCode, 'NETWORK_ERROR');
      assert.equal(a.httpStatus, 500);
      assert.equal(a.fetchMethod, 'static_http');
    }
    // 失败读模型暴露该任务。
    const list = listSourceBodyCaptureFailures(database, {});
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].jobId, jobId);
    assert.equal(list.items[0].attempts, 3);
    assert.equal(list.items[0].reasonCategory, 'network');
  } finally {
    database.close();
  }
});

test('WMB-5269 retry-after: header extends next attempt beyond system backoff; short header never shortens it', async () => {
  const { database } = makeDatabase();
  try {
    // Retry-After 7200s ≫ 系统退避 → next_attempt_at 被拉到 header。
    const longSource = seedSource(database, '限流源', 'https://example.com/ra-long');
    const { jobId: longJob } = scheduleSourceBodyArchive(database, { sourceId: longSource.id, sourceRevision: 1, url: 'https://example.com/ra-long' });
    const now = new Date(Date.now() + 60_000).toISOString();
    let claim = claimSourceBodyJob(database, longJob, 0, { now });
    assert.equal(claim.claimed, true);
    let outcome = await executeSourceBodyCapture(database, claim.job, {
      fetchImpl: fakeFetch(() => ({ status: 429, headers: { 'content-type': 'text/html', 'retry-after': '7200' }, body: 'slow down' })),
      lookupImpl: resolveHost()
    });
    assert.equal(outcome.code, 'HTTP_RATE_LIMITED');
    assert.equal(outcome.retryAfterSeconds, 7200);
    let finish = finishSourceBodyJob(database, { jobId: longJob, expectedAttempts: 1, outcome, now });
    assert.equal(finish.jobStatus, 'retry_wait');
    let job = jobRow(database, longJob);
    assert.equal(job.reasonCategory, 'http');
    assert.equal(job.retryable, 1);
    const longDelay = Date.parse(job.nextAttemptAt) - Date.parse(now);
    assert.ok(longDelay >= 7_200_000, `Retry-After 7200s 应主导退避，实际 ${longDelay}ms`);

    // Retry-After 5s ≪ 系统退避 → 仍按系统退避（不提前）。
    const shortSource = seedSource(database, '限流源B', 'https://example.com/ra-short');
    const { jobId: shortJob } = scheduleSourceBodyArchive(database, { sourceId: shortSource.id, sourceRevision: 1, url: 'https://example.com/ra-short' });
    const now2 = new Date(Date.now() + 120_000).toISOString();
    claim = claimSourceBodyJob(database, shortJob, 0, { now: now2 });
    assert.equal(claim.claimed, true);
    outcome = await executeSourceBodyCapture(database, claim.job, {
      fetchImpl: fakeFetch(() => ({ status: 429, headers: { 'content-type': 'text/html', 'retry-after': '5' }, body: 'slow down' })),
      lookupImpl: resolveHost()
    });
    finish = finishSourceBodyJob(database, { jobId: shortJob, expectedAttempts: 1, outcome, now: now2 });
    assert.equal(finish.jobStatus, 'retry_wait');
    job = jobRow(database, shortJob);
    const shortDelay = Date.parse(job.nextAttemptAt) - Date.parse(now2);
    assert.ok(shortDelay >= 95_999 && shortDelay <= 144_001, `短 Retry-After 不得早于系统退避，实际 ${shortDelay}ms`);
  } finally {
    database.close();
  }
});

// ============ G. 不可重试行为：安全/认证/HTTP/内容 ============

test('WMB-5269 nonretryable outcomes: security/auth/http/content terminal needs_review on first attempt', async () => {
  const { database } = makeDatabase();
  try {
    const cases = [
      {
        name: 'URL_SECURITY_BLOCKED',
        fetch: fakeFetch(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: 'ok' })),
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        code: 'URL_SECURITY_BLOCKED', category: 'security'
      },
      { name: 'HTTP_UNAUTHORIZED', fetch: fetch401, code: 'HTTP_UNAUTHORIZED', category: 'auth' },
      { name: 'HTTP_FORBIDDEN', fetch: fakeFetch(() => ({ status: 403, headers: { 'content-type': 'text/html' }, body: 'forbidden' })), code: 'HTTP_FORBIDDEN', category: 'auth' },
      { name: 'HTTP_NOT_FOUND', fetch: fetch404, code: 'HTTP_NOT_FOUND', category: 'http' },
      { name: 'HTTP_GONE', fetch: fakeFetch(() => ({ status: 410, headers: { 'content-type': 'text/html' }, body: 'gone' })), code: 'HTTP_GONE', category: 'http' },
      {
        name: 'CAPTCHA_DETECTED',
        fetch: fakeFetch(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>Just a moment... cf-browser-verification</body></html>' })),
        code: 'CAPTCHA_DETECTED', category: 'auth'
      },
      {
        name: 'CONTENT_TYPE_UNSUPPORTED',
        fetch: fakeFetch(() => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'binary' })),
        code: 'CONTENT_TYPE_UNSUPPORTED', category: 'content'
      }
    ];

    for (const c of cases) {
      const source = seedSource(database, c.name, `https://example.com/${c.name}`);
      const { jobId } = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: `https://example.com/${c.name}` });
      const now = new Date(Date.now() + 60_000).toISOString();
      const claim = claimSourceBodyJob(database, jobId, 0, { now });
      assert.equal(claim.claimed, true, c.name);
      const outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl: c.fetch, lookupImpl: c.lookup ?? resolveHost() });
      assert.equal(outcome.outcome, 'failed', c.name);
      assert.equal(outcome.code, c.code, c.name);
      assert.equal(outcome.retryable, false, `${c.name} 应不可自动重试`);
      const finish = finishSourceBodyJob(database, { jobId, expectedAttempts: 1, outcome, now });
      assert.equal(finish.jobStatus, 'needs_review', `${c.name} 应立即终态（不进入 retry_wait）`);
      const job = jobRow(database, jobId);
      assert.equal(job.status, 'needs_review', c.name);
      assert.equal(job.attemptCount, 1, `${c.name} 只应实际尝试 1 次`);
      assert.equal(job.reasonCategory, c.category, c.name);
      assert.equal(job.retryable, 0, c.name);
      assert.equal(job.lastErrorCode, c.code, c.name);
      const cache = getSourceBodyCache(database, source.id);
      assert.equal(cache.status, 'failed', `${c.name} 应写失败投影`);
      assert.ok(cache.errorMessage && cache.errorMessage.length > 0, c.name);
    }

    // 失败列表只暴露终态失败行，分类聚合正确。
    const list = listSourceBodyCaptureFailures(database, {});
    assert.equal(list.items.length, cases.length);
    const byCategory = new Map();
    for (const item of list.items) byCategory.set(item.reasonCategory, (byCategory.get(item.reasonCategory) ?? 0) + 1);
    assert.equal(byCategory.get('security'), 1);
    assert.equal(byCategory.get('auth'), 3);
    assert.equal(byCategory.get('http'), 2);
    assert.equal(byCategory.get('content'), 1);
  } finally {
    database.close();
  }
});

// ============ H. 孤儿 running 恢复 ============

test('WMB-5269 recovery: stale running reclaimed to pending (attempts left) or needs_review (exhausted)', async () => {
  const { database } = makeDatabase();
  try {
    // job A：1 次 claim 后孤儿 running → 恢复 pending，attempt 行标记 EXECUTION_INTERRUPTED。
    const srcA = seedSource(database, '恢复A', 'https://example.com/recover-a');
    const { jobId: jobA } = scheduleSourceBodyArchive(database, { sourceId: srcA.id, sourceRevision: 1, url: 'https://example.com/recover-a' });
    const claimNow = new Date(Date.now() + 60_000).toISOString();
    assert.equal(claimSourceBodyJob(database, jobA, 0, { now: claimNow }).claimed, true);
    database.prepare('UPDATE source_body_capture_jobs SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', jobA);

    const result = recoverInterruptedSourceBodyJobs(database, { staleAfterMs: 1000, now: '2026-08-15T00:00:00.000Z' });
    assert.deepEqual(result, { recovered: 1, exhausted: 0 });
    let row = jobRow(database, jobA);
    assert.equal(row.status, 'pending');
    assert.equal(row.lastErrorCode, 'EXECUTION_INTERRUPTED');
    assert.equal(row.startedAt, null);
    assert.equal(row.attemptCount, 1);
    let attempts = attemptRows(database, jobA);
    assert.equal(attempts[0].status, 'failed');
    assert.equal(attempts[0].errorCode, 'EXECUTION_INTERRUPTED');
    assert.ok(attempts[0].errorMessage.includes('执行中断'));

    // 恢复后可继续 claim（attempt 2）。
    const again = claimSourceBodyJob(database, jobA, 1, { now: '2026-08-15T00:00:01.000Z' });
    assert.equal(again.claimed, true);
    assert.equal(again.attemptNumber, 2);
    const recoveredOutcome = await executeSourceBodyCapture(database, again.job, { fetchImpl: goodHtml, lookupImpl: resolveHost() });
    assert.equal(finishSourceBodyJob(database, {
      jobId: jobA,
      expectedAttempts: again.attemptNumber,
      outcome: recoveredOutcome,
      now: '2026-08-15T00:00:01.000Z'
    }).jobStatus, 'ready');

    // job B：3 次尝试后孤儿 running → 恢复 needs_review（已达自动上限）。
    const srcB = seedSource(database, '恢复B', 'https://example.com/recover-b');
    const { jobId: jobB } = scheduleSourceBodyArchive(database, { sourceId: srcB.id, sourceRevision: 1, url: 'https://example.com/recover-b' });
    const farBase = Date.now() + 3_600_000;
    let expected = 0;
    for (let i = 1; i <= 3; i += 1) {
      const claimNow = new Date(farBase + i * 3_600_000).toISOString();
      const claim = claimSourceBodyJob(database, jobB, expected, { now: claimNow });
      assert.equal(claim.claimed, true);
      if (i < 3) {
        const outcome = await executeSourceBodyCapture(database, claim.job, { fetchImpl: fetch500, lookupImpl: resolveHost() });
        const finish = finishSourceBodyJob(database, { jobId: jobB, expectedAttempts: claim.attemptNumber, outcome, now: claimNow });
        assert.equal(finish.jobStatus, 'retry_wait');
        expected = claim.attemptNumber;
      }
      // i === 3：只 claim 不 finish —— 模拟进程在第三次尝试中崩溃。
    }
    assert.equal(jobRow(database, jobB).attemptCount, 3);
    database.prepare('UPDATE source_body_capture_jobs SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', jobB);

    const result2 = recoverInterruptedSourceBodyJobs(database, { staleAfterMs: 1000, now: '2026-08-15T00:00:00.000Z' });
    assert.deepEqual(result2, { recovered: 0, exhausted: 1 });
    row = jobRow(database, jobB);
    assert.equal(row.status, 'needs_review');
    assert.equal(row.lastErrorCode, 'EXECUTION_INTERRUPTED');
    assert.equal(row.reasonCategory, 'unknown');
    assert.equal(row.finishedAt, '2026-08-15T00:00:00.000Z');
    attempts = attemptRows(database, jobB);
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2].status, 'failed');
    assert.equal(attempts[2].errorCode, 'EXECUTION_INTERRUPTED');

    // 新鲜 running（租约未过期）不被回收。
    const srcC = seedSource(database, '恢复C', 'https://example.com/recover-c');
    const { jobId: jobC } = scheduleSourceBodyArchive(database, { sourceId: srcC.id, sourceRevision: 1, url: 'https://example.com/recover-c' });
    assert.equal(claimSourceBodyJob(database, jobC, 0, { now: new Date(farBase).toISOString() }).claimed, true);
    const result3 = recoverInterruptedSourceBodyJobs(database, { staleAfterMs: SOURCE_BODY_STALE_RUNNING_MS, now: new Date().toISOString() });
    assert.deepEqual(result3, { recovered: 0, exhausted: 0 });
    assert.equal(jobRow(database, jobC).status, 'running');
  } finally {
    database.close();
  }
});

// ============ I. 历史补抓：keyset 分页 / 去重 / 排除 ============

test('WMB-5269 backfill: keyset pages advance cursor, no duplicate registration, excludes archived/already-ready/no-url', () => {
  const { database } = makeDatabase();
  try {
    // 4 个普通候选（collected_at 08-01..08-04）+ 1 个官网渠道候选（08-05，最新）。
    const plains = [];
    for (let i = 1; i <= 4; i += 1) {
      plains.push(seedSource(database, `n${i}`, `https://example.com/n${i}`, { collectedAt: `2026-08-0${i}T00:00:00.000Z` }));
    }
    const feed = createSourceFeed(database, { name: '官网测试' });
    database.prepare(`INSERT INTO website_sources (id, source_feed_id, input_text, canonical_url, enabled, resolution_status, resolution_json, created_at, updated_at, revision)
      VALUES (?, ?, '测试', 'https://example.com/feed', 1, 'ready', '{}', ?, ?, 1)`)
      .run(randomUUID(), feed.id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    const ch = seedSource(database, '官网候选', 'https://example.com/ch', { collectedAt: '2026-08-05T00:00:00.000Z', feedId: feed.id });

    // 排除项：archived、已有 ready revision、无 URL。
    const archived = seedSource(database, '已归档', 'https://example.com/archived', { collectedAt: '2026-08-06T00:00:00.000Z' });
    database.prepare("UPDATE source_items SET management_status = 'archived' WHERE id = ?").run(archived.id);
    const withReady = seedSource(database, '已有正文', 'https://example.com/with-ready', { collectedAt: '2026-08-07T00:00:00.000Z' });
    seedReadyRevision(database, withReady.id, '已有正文基线文本。');
    const noUrl = seedSource(database, '无链接', null, { collectedAt: '2026-08-08T00:00:00.000Z' });

    // 倒序候选：ch(08-05), n4, n3, n2, n1。
    const page1 = runSourceBodyBackfillPage(database, { pageSize: 2, now: '2026-08-15T00:00:00.000Z' });
    assert.equal(page1.registered, 2);
    assert.equal(page1.done, false);
    let cursor = JSON.parse(backfillCursorValue(database));
    assert.equal(cursor.id, plains[3].id, '水位应推进到第一页最后一条（n4）');

    let jobs = database.prepare('SELECT source_id AS sourceId, priority, status, url, channel, fetch_method AS fetchMethod FROM source_body_capture_jobs').all();
    assert.equal(jobs.length, 2);
    const bySource = new Map(jobs.map((j) => [j.sourceId, j]));
    assert.equal(bySource.get(ch.id).priority, 'historical_backfill');
    assert.equal(bySource.get(ch.id).status, 'pending');
    assert.equal(bySource.get(ch.id).fetchMethod, 'static_http');
    assert.equal(bySource.get(ch.id).channel, 'official_web', '官网归属应推导渠道');
    assert.equal(bySource.get(plains[3].id).channel, null);

    const page2 = runSourceBodyBackfillPage(database, { pageSize: 2, now: '2026-08-15T00:00:00.000Z' });
    assert.equal(page2.registered, 2);
    assert.equal(page2.done, false);
    cursor = JSON.parse(backfillCursorValue(database));
    assert.equal(cursor.id, plains[1].id, '水位应推进到 n2');

    // 末页不满页 → 直接 done。
    const page3 = runSourceBodyBackfillPage(database, { pageSize: 2, now: '2026-08-15T00:00:00.000Z' });
    assert.equal(page3.registered, 1);
    assert.equal(page3.done, true);
    assert.equal(backfillCursorValue(database), 'done');

    // 5 个候选全部登记、无重复；排除项不产生 job。
    jobs = database.prepare('SELECT source_id AS sourceId FROM source_body_capture_jobs').all();
    assert.equal(jobs.length, 5);
    const allIds = jobs.map((j) => j.sourceId);
    assert.ok(!allIds.includes(archived.id), 'archived 不登记');
    assert.ok(!allIds.includes(withReady.id), '已有 ready 正文不登记');
    assert.ok(!allIds.includes(noUrl.id), '无 URL 不登记');
    assert.equal(new Set(allIds).size, 5, '同 revision 不得重复登记');

    // done 后再跑：零登记。
    const again = runSourceBodyBackfillPage(database, { pageSize: 2 });
    assert.deepEqual(again, { registered: 0, done: true });

    // 重置水位重扫：已存在 job 的 source 不重复登记，水位继续推进。
    database.prepare("UPDATE app_meta SET value = 'not_started', updated_at = ? WHERE key = 'source_body_backfill_cursor'").run('2026-08-15T00:00:00.000Z');
    const rescan = runSourceBodyBackfillPage(database, { pageSize: 2, now: '2026-08-15T00:00:00.000Z' });
    assert.equal(rescan.registered, 0, '重扫不得重复登记已存在的 revision');
    assert.equal(rescan.done, false);
    assert.equal(countJobs(database), 5, 'job 总数保持不变');
  } finally {
    database.close();
  }
});

// ============ J. 重试：selected / reason / all ============

test('WMB-5269 retry scope all: retryable-only, excluded list, attempts history preserved', async () => {
  const { database } = makeDatabase();
  try {
    const all = await seedTerminalFailures(database, [
      { title: 'A', url: 'https://example.com/a', kind: 'fetch', fetch: fetch500, retryable: true },
      { title: 'B', url: 'https://example.com/b', kind: 'fetch', fetch: fetch404, retryable: false },
      { title: 'C', kind: 'no_source', retryable: false },
      { title: 'D', url: 'https://example.com/d', kind: 'fetch', fetch: fetch500, retryable: true }
    ]);
    assert.equal(all[0].status, 'needs_review');
    assert.equal(all[1].status, 'needs_review');
    assert.equal(jobRow(database, all[2].jobId).status, 'unavailable');

    const retried = retrySourceBodyCaptureFailures(database, { scope: 'all' });
    assert.equal(retried.retried, 2);
    assert.equal(retried.excluded, 2);
    assert.deepEqual(retried.excludedJobIds.sort(), [all[1].jobId, all[2].jobId].sort());

    // A/D：新周期（attempt 归零、错误清空、回 pending）。
    for (const idx of [0, 3]) {
      const job = jobRow(database, all[idx].jobId);
      assert.equal(job.status, 'pending');
      assert.equal(job.attemptCount, 0);
      assert.equal(job.lastErrorCode, null);
      assert.equal(job.lastErrorMessage, null);
      assert.equal(job.reasonCategory, null);
      assert.equal(job.retryable, 1);
      assert.equal(job.fetchMethod, 'static_http');
      assert.equal(job.finishedAt, null);
      assert.equal(attemptRows(database, all[idx].jobId).length, 3, 'attempts 历史必须保留');
    }
    // B/C：非可重试终态保持。
    assert.equal(jobRow(database, all[1].jobId).status, 'needs_review');
    assert.equal(jobRow(database, all[2].jobId).status, 'unavailable');

    // 再跑 all：已重试项不再重复；非可重试项仍被排除。
    const again = retrySourceBodyCaptureFailures(database, { scope: 'all' });
    assert.equal(again.retried, 0);
    assert.equal(again.excluded, 2);
  } finally {
    database.close();
  }
});

test('WMB-5269 retry scope reason: category filter with retryable eligibility', async () => {
  const { database } = makeDatabase();
  try {
    const all = await seedTerminalFailures(database, [
      { title: 'A', url: 'https://example.com/a2', kind: 'fetch', fetch: fetch500, retryable: true }, // network
      { title: 'B', url: 'https://example.com/b2', kind: 'fetch', fetch: fakeFetch(() => ({ status: 429, headers: { 'content-type': 'text/html' }, body: 'slow' })), retryable: true }, // http (rate limited)
      { title: 'C', kind: 'no_source', retryable: false }, // no_source
      { title: 'D', url: 'https://example.com/d2', kind: 'fetch', fetch: fetch401, retryable: false } // auth
    ]);
    assert.equal(all[0].status, 'needs_review');
    assert.equal(all[1].status, 'needs_review');

    const http = retrySourceBodyCaptureFailures(database, { scope: 'reason', reasonCategory: 'http' });
    assert.equal(http.retried, 1);
    assert.deepEqual(http.excludedJobIds, []);
    assert.equal(jobRow(database, all[1].jobId).status, 'pending');

    const network = retrySourceBodyCaptureFailures(database, { scope: 'reason', reasonCategory: 'network' });
    assert.equal(network.retried, 1);
    assert.equal(jobRow(database, all[0].jobId).status, 'pending');

    // no_source / auth：非可重试项被 reason 批量重试排除。
    const noSource = retrySourceBodyCaptureFailures(database, { scope: 'reason', reasonCategory: 'no_source' });
    assert.equal(noSource.retried, 0);
    assert.equal(noSource.excluded, 1);
    assert.deepEqual(noSource.excludedJobIds, [all[2].jobId]);

    const auth = retrySourceBodyCaptureFailures(database, { scope: 'reason', reasonCategory: 'auth' });
    assert.equal(auth.retried, 0);
    assert.equal(auth.excluded, 1);
    assert.deepEqual(auth.excludedJobIds, [all[3].jobId]);

    // 缺 category → 空结果。
    const empty = retrySourceBodyCaptureFailures(database, { scope: 'reason' });
    assert.deepEqual(empty, { retried: 0, excluded: 0, excludedJobIds: [] });
  } finally {
    database.close();
  }
});

test('WMB-5269 retry scope selected: explicit selection retries nonretryable too; unknown/non-terminal excluded', async () => {
  const { database } = makeDatabase();
  try {
    const all = await seedTerminalFailures(database, [
      { title: 'A', url: 'https://example.com/a3', kind: 'fetch', fetch: fetch500, retryable: true },
      { title: 'B', url: 'https://example.com/b3', kind: 'fetch', fetch: fetch404, retryable: false }
    ]);
    const pendingSource = seedSource(database, 'pending', 'https://example.com/p3');
    const pendingJob = scheduleSourceBodyArchive(database, { sourceId: pendingSource.id, sourceRevision: 1, url: 'https://example.com/p3' });
    assert.equal(pendingJob.status, 'pending');

    const selected = retrySourceBodyCaptureFailures(database, {
      scope: 'selected',
      jobIds: [all[1].jobId, all[0].jobId, 'missing-job', pendingJob.jobId]
    });
    assert.equal(selected.retried, 2, '显式人工选择允许任意终态项（含非可重试）');
    assert.equal(selected.excluded, 2);
    assert.deepEqual(selected.excludedJobIds.sort(), ['missing-job', pendingJob.jobId].sort());

    assert.equal(jobRow(database, all[0].jobId).status, 'pending');
    assert.equal(jobRow(database, all[1].jobId).status, 'pending', '非可重试项经人工选择也可重试');
    assert.equal(attemptRows(database, all[1].jobId).length, 1, 'attempts 历史保留');

    // 空选择 → 空结果。
    const none = retrySourceBodyCaptureFailures(database, { scope: 'selected', jobIds: [] });
    assert.deepEqual(none, { retried: 0, excluded: 0, excludedJobIds: [] });
  } finally {
    database.close();
  }
});

// ============ K. 失败读模型：分页 keyset / 分类过滤 ============

test('WMB-5269 failure read model: terminal-only, keyset pagination, category filter, field contract', async () => {
  const { database } = makeDatabase();
  try {
    const spec = [
      { title: 'F1', url: 'https://example.com/f1', kind: 'fetch', fetch: fetch500, at: '2026-08-15T01:00:00.000Z', category: 'network' },
      { title: 'F2', url: 'https://example.com/f2', kind: 'fetch', fetch: fetch404, at: '2026-08-15T02:00:00.000Z', category: 'http' },
      { title: 'F3', url: 'https://example.com/f3', kind: 'fetch', fetch: fetch500, at: '2026-08-15T03:00:00.000Z', category: 'network' },
      { title: 'F4', kind: 'no_source', at: '2026-08-15T04:00:00.000Z', category: 'no_source' }
    ];
    const jobs = [];
    for (const s of spec) {
      const source = seedSource(database, s.title, s.url);
      if (s.kind === 'no_source') {
        const res = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1 });
        database.prepare('UPDATE source_body_capture_jobs SET finished_at = ? WHERE id = ?').run(s.at, res.jobId);
        jobs.push({ jobId: res.jobId, sourceId: source.id, ...s });
      } else {
        const res = scheduleSourceBodyArchive(database, { sourceId: source.id, sourceRevision: 1, url: s.url });
        await failJobToTerminal(database, res.jobId, s.fetch, resolveHost());
        database.prepare('UPDATE source_body_capture_jobs SET finished_at = ? WHERE id = ?').run(s.at, res.jobId);
        jobs.push({ jobId: res.jobId, sourceId: source.id, ...s });
      }
    }
    // ready 任务不应出现在失败读模型。
    const ok = seedSource(database, 'OK', 'https://example.com/ok');
    const okJob = scheduleSourceBodyArchive(database, { sourceId: ok.id, sourceRevision: 1, url: 'https://example.com/ok' });
    await succeedJob(database, okJob.jobId, goodHtml, resolveHost());

    // keyset 分页：finished_at DESC, id DESC。
    const page1 = listSourceBodyCaptureFailures(database, { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    assert.equal(page1.items[0].jobId, jobs[3].jobId, 'F4(04:00) 最新在前');
    assert.equal(page1.items[1].jobId, jobs[2].jobId, 'F3(03:00) 其次');
    const page2 = listSourceBodyCaptureFailures(database, { limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.nextCursor, null);
    assert.equal(page2.items[0].jobId, jobs[1].jobId);
    assert.equal(page2.items[1].jobId, jobs[0].jobId);
    assert.ok(!page1.items.some((a) => a.jobId === page2.items[0].jobId || a.jobId === page2.items[1].jobId), '两页不得重叠');

    // 字段契约。
    const f4 = page1.items[0];
    assert.equal(f4.sourceId, jobs[3].sourceId);
    assert.equal(f4.title, 'F4');
    assert.equal(f4.url, null);
    assert.equal(f4.reasonCategory, 'no_source');
    assert.equal(f4.retryable, false);
    assert.equal(f4.attempts, 0);
    assert.equal(f4.failedAt, '2026-08-15T04:00:00.000Z');
    assert.equal(f4.fetchMethod, 'none');
    const f1 = page2.items[1];
    assert.equal(f1.reasonCategory, 'network');
    assert.equal(f1.retryable, true);
    assert.equal(f1.attempts, 3);
    assert.equal(f1.errorCode, 'NETWORK_ERROR');
    assert.equal(f1.lastHttpStatus, 500);
    assert.equal(f1.domain, 'example.com');
    assert.equal(f1.fetchMethod, 'static_http');
    assert.ok(f1.failedAt.length > 0);

    // 分类过滤。
    const network = listSourceBodyCaptureFailures(database, { reasonCategory: 'network' });
    assert.equal(network.items.length, 2);
    assert.ok(network.items.every((i) => i.reasonCategory === 'network' && i.retryable === true));
    const http = listSourceBodyCaptureFailures(database, { reasonCategory: 'http' });
    assert.equal(http.items.length, 1);
    assert.equal(http.items[0].jobId, jobs[1].jobId);
    // 分类过滤 + 分页。
    const netPage = listSourceBodyCaptureFailures(database, { reasonCategory: 'network', limit: 1 });
    assert.equal(netPage.items.length, 1);
    assert.ok(netPage.nextCursor);
  } finally {
    database.close();
  }
});

// ============ L. 生产入口：ingestion → 调度正文任务 → worker 处理 ============

test('WMB-5269 production: dispatchSourceUpsertBatch schedules body jobs; runDueSourceBodyJobs drains via dispatcher', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wmb-5269-prod-'));
  let runtime = null;
  try {
    // 与 withRuntime 助手一致：先建库并写入工作空间身份，再以真实 runtime 打开。
    const seedDb = migrateDatabase(path.join(root, 'wmb.db'));
    const now = new Date().toISOString();
    seedDb.prepare("INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES ('workspace_id', ?, ?, ?, 1)")
      .run('ws-5269-prod', now, now);
    seedDb.close();
    runtime = ActiveWorkspaceRuntime.open(root, { openDatabase: migrateDatabase, createEpoch: () => 'wmb-5269-runtime' });
    const owner = { type: 'owner_ui', id: 'renderer', label: 'Owner UI' };
    const items = [
      { title: '结构化来源', originalUrl: 'https://example.com/p1', bodyCandidate: { kind: 'full_text', text: '生产路径结构化正文。', contentType: 'text/plain', origin: 'test' } },
      { title: 'URL来源', originalUrl: 'https://example.com/p2' }
    ];
    const receipt = await dispatchSourceUpsertBatch(runtime, { requestId: 'wmb5269-ingest', actor: owner, items });
    assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? null));
    assert.equal(receipt.data.items.length, 2);

    // 生产保存事务内登记了两条正文任务：ready（channel_text）+ pending（static_http）。
    let jobs = runtime.database.prepare('SELECT source_id AS sourceId, status, priority, fetch_method AS fetchMethod FROM source_body_capture_jobs').all();
    assert.equal(jobs.length, 2);
    const byStatus = new Map(jobs.map((j) => [j.status, j]));
    assert.equal(byStatus.get('ready').fetchMethod, 'channel_text');
    assert.equal(byStatus.get('ready').priority, 'new_source');
    assert.equal(byStatus.get('pending').fetchMethod, 'static_http');
    assert.equal(byStatus.get('pending').priority, 'new_source');

    const p1 = receipt.data.sources.find((s) => s.title === '结构化来源');
    const p2 = receipt.data.sources.find((s) => s.title === 'URL来源');
    assert.ok(p1 && p2);
    const cache1 = getSourceBodyCache(runtime.database, p1.id);
    assert.equal(cache1.status, 'ready');
    assert.equal(cache1.extractedText, '生产路径结构化正文。');

    // 同 requestId 同输入重放 → 原回执，不新增 job。
    const replay = await dispatchSourceUpsertBatch(runtime, { requestId: 'wmb5269-ingest', actor: owner, items });
    assert.deepEqual(replay.data, receipt.data);
    assert.equal(runtime.database.prepare('SELECT COUNT(*) AS n FROM source_body_capture_jobs').get().n, 2);

    // Worker 生产模式：claim/finish 经 dispatcher 授权，抓取走注入缝。
    const run = await runDueSourceBodyJobs(runtime, { deps: { fetchImpl: goodHtml, lookupImpl: resolveHost() } });
    assert.equal(run.processed, 1);
    assert.equal(run.ready, 1);
    assert.equal(run.failed, 0);
    assert.equal(run.stale, 0);
    const job2 = runtime.database.prepare('SELECT status, fetch_method AS fetchMethod, attempt_count AS attemptCount FROM source_body_capture_jobs WHERE source_id = ?').get(p2.id);
    assert.equal(job2.status, 'ready');
    assert.equal(job2.fetchMethod, 'static_http');
    assert.equal(job2.attemptCount, 1);
    const cache2 = getSourceBodyCache(runtime.database, p2.id);
    assert.equal(cache2.status, 'ready');
    assert.ok(cache2.extractedText.includes('可读正文内容'));

    // 再次运行：无到期任务。
    const drained = await runDueSourceBodyJobs(runtime, { deps: { fetchImpl: goodHtml, lookupImpl: resolveHost() } });
    assert.equal(drained.processed, 0);
  } finally {
    if (runtime) await runtime.stop({ drain: false });
    rmSync(root, { recursive: true, force: true });
  }
});

// ============ M. 全局暂停标记 ============

test('WMB-5269 pause flag: set/get round trip via app_meta', () => {
  const { database } = makeDatabase();
  try {
    assert.equal(isSourceBodyArchivePaused(database), false);
    setSourceBodyArchivePaused(database, true);
    assert.equal(isSourceBodyArchivePaused(database), true);
    setSourceBodyArchivePaused(database, false);
    assert.equal(isSourceBodyArchivePaused(database), false);
  } finally {
    database.close();
  }
});
