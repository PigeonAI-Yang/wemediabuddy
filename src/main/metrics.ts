import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure, success, type CommandResult } from './result.ts';
import { recordOperation } from './operations.ts';

const WINDOWS_MS = [
  { key: '1h', ms: 1 * 60 * 60 * 1000 },
  { key: '6h', ms: 6 * 60 * 60 * 1000 },
  { key: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '72h', ms: 72 * 60 * 60 * 1000 }
] as const;

export type MetricJob = {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'needs_user';
  dueAt: string;
  attempts: number;
  dedupeKey: string;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type MetricSnapshot = {
  id: string;
  publicationId: string;
  scheduledFor: string;
  capturedAt: string;
  sourceUrl: string;
  normalized: Record<string, unknown>;
  raw: Record<string, unknown>;
  createdAt: string;
};

type JobRow = {
  id: string;
  kind: string;
  status: MetricJob['status'];
  due_at: string;
  attempts: number;
  dedupe_key: string;
  payload_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function parseJob(row: JobRow): MetricJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    dueAt: row.due_at,
    attempts: row.attempts,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export function schedulePublicationMetricJobs(
  database: DatabaseSync,
  input: { publicationId: string; publishedAt: string; sourceUrl: string; platform: string },
  audit = true
): CommandResult<{ created: number; jobs: MetricJob[] }> {
  if (!input.sourceUrl) return failure('VALIDATION_ERROR', '没有可采集的发布 URL。');
  const publishedMs = Date.parse(input.publishedAt);
  if (Number.isNaN(publishedMs)) return failure('VALIDATION_ERROR', 'published_at 无效。');
  const now = new Date().toISOString();
  const jobs: MetricJob[] = [];
  let created = 0;
  for (const window of WINDOWS_MS) {
    const dueAt = new Date(publishedMs + window.ms).toISOString();
    const dedupeKey = `metric:${input.publicationId}:${window.key}`;
    const existing = database.prepare('SELECT id FROM jobs WHERE dedupe_key = ?').get(dedupeKey) as { id: string } | undefined;
    if (existing) {
      const row = database.prepare(`SELECT * FROM jobs WHERE id = ?`).get(existing.id) as JobRow;
      jobs.push(parseJob(row));
      continue;
    }
    const id = randomUUID();
    const payload = {
      publicationId: input.publicationId,
      platform: input.platform,
      sourceUrl: input.sourceUrl,
      scheduledFor: dueAt,
      window: window.key
    };
    database.prepare(`INSERT INTO jobs (
      id, kind, status, due_at, attempts, dedupe_key, payload_json, last_error, created_at, updated_at, started_at, finished_at
    ) VALUES (?, 'publication_metrics', 'pending', ?, 0, ?, ?, NULL, ?, ?, NULL, NULL)`).run(
      id, dueAt, dedupeKey, JSON.stringify(payload), now, now
    );
    created += 1;
    jobs.push(parseJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow));
  }
  if (audit && created) recordOperation(database, {
    actorType: 'ui', command: 'metrics.schedule', entityType: 'publication', entityId: input.publicationId, result: 'ok'
  });
  return success({ created, jobs });
}

export function hasScheduledPublicationMetricJobs(database: DatabaseSync, publicationId: string): boolean {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE kind = 'publication_metrics' AND dedupe_key LIKE ?`)
    .get(`metric:${publicationId}:%`) as { count: number };
  return row.count >= WINDOWS_MS.length;
}

export function listMetricJobs(database: DatabaseSync, publicationId?: string): MetricJob[] {
  const rows = publicationId
    ? database.prepare(`SELECT * FROM jobs WHERE kind = 'publication_metrics' AND payload_json LIKE ? ORDER BY due_at`).all(`%${publicationId}%`) as JobRow[]
    : database.prepare(`SELECT * FROM jobs WHERE kind = 'publication_metrics' ORDER BY due_at`).all() as JobRow[];
  return rows.map(parseJob);
}

export function recoverRunningMetricJobs(database: DatabaseSync): number {
  const now = new Date().toISOString();
  const result = database.prepare(`UPDATE jobs SET status = 'pending', updated_at = ?, started_at = NULL
    WHERE kind = 'publication_metrics' AND status = 'running'`).run(now);
  return Number(result.changes ?? 0);
}

export function recoverMetricJob(database: DatabaseSync, jobId: string, expectedAttempts: number, recoveredAt: string): CommandResult<MetricJob> {
  const changed = database.prepare(`UPDATE jobs SET status = 'pending', updated_at = ?, started_at = NULL
    WHERE id = ? AND kind = 'publication_metrics' AND status = 'running' AND attempts = ?`)
    .run(recoveredAt, jobId, expectedAttempts);
  if (Number(changed.changes ?? 0) !== 1) return failure('REVISION_CONFLICT', '指标任务恢复身份已失效。');
  return success(parseJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow));
}

export function claimMetricJob(database: DatabaseSync, jobId: string, expectedAttempts: number, claimedAt: string): CommandResult<MetricJob> {
  const changed = database.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
    WHERE id = ? AND kind = 'publication_metrics' AND status = 'pending' AND attempts = ? AND due_at <= ?`)
    .run(claimedAt, claimedAt, jobId, expectedAttempts, claimedAt);
  if (Number(changed.changes ?? 0) !== 1) return failure('REVISION_CONFLICT', '指标任务认领身份已失效。');
  return success(parseJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow));
}

export function claimDueMetricJobs(database: DatabaseSync, nowIso = new Date().toISOString(), limit = 20): MetricJob[] {
  const rows = database.prepare(`SELECT * FROM jobs
    WHERE kind = 'publication_metrics' AND status = 'pending' AND due_at <= ?
    ORDER BY due_at LIMIT ?`).all(nowIso, limit) as JobRow[];
  const claimed: MetricJob[] = [];
  for (const row of rows) {
    const updated = database.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(nowIso, nowIso, row.id);
    if (Number(updated.changes ?? 0) === 1) {
      claimed.push(parseJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id) as JobRow));
    }
  }
  return claimed;
}

export function completeMetricJob(
  database: DatabaseSync,
  input: {
    jobId: string;
    publicationId: string;
    scheduledFor: string;
    sourceUrl: string;
    capturedAt: string;
    normalized: Record<string, unknown>;
    raw: Record<string, unknown>;
    expectedAttempts?: number;
  },
  transaction = true,
  audit = true
): CommandResult<MetricSnapshot> {
  const job = database.prepare('SELECT * FROM jobs WHERE id = ?').get(input.jobId) as JobRow | undefined;
  if (!job) return failure('NOT_FOUND', '指标任务不存在。');
  if (input.expectedAttempts !== undefined && (job.attempts !== input.expectedAttempts || job.status !== 'running')) {
    return failure('REVISION_CONFLICT', '指标任务执行身份已失效。');
  }
  if (job.status !== 'running' && job.status !== 'pending') return failure('INVALID_STATE', '任务状态不可完成。');

  const existing = database.prepare(`SELECT id FROM publication_metric_snapshots
    WHERE publication_id = ? AND scheduled_for = ?`).get(input.publicationId, input.scheduledFor) as { id: string } | undefined;
  if (existing) {
    const now = new Date().toISOString();
    database.prepare(`UPDATE jobs SET status = 'succeeded', finished_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`)
      .run(now, now, input.jobId);
    const snapshot = database.prepare(`SELECT id, publication_id AS publicationId, scheduled_for AS scheduledFor, captured_at AS capturedAt,
      source_url AS sourceUrl, normalized_json AS normalized, raw_json AS raw, created_at AS createdAt
      FROM publication_metric_snapshots WHERE id = ?`).get(existing.id) as {
      id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string; normalized: string; raw: string; createdAt: string;
    };
    return success({
      ...snapshot,
      normalized: JSON.parse(snapshot.normalized),
      raw: JSON.parse(snapshot.raw)
    });
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO publication_metric_snapshots (
      id, publication_id, scheduled_for, captured_at, source_url, normalized_json, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      input.publicationId,
      input.scheduledFor,
      input.capturedAt,
      input.sourceUrl,
      JSON.stringify(input.normalized),
      JSON.stringify(input.raw),
      now
    );
    database.prepare(`UPDATE jobs SET status = 'succeeded', finished_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`)
      .run(now, now, input.jobId);
    if (transaction) database.exec('COMMIT');
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
  if (audit) recordOperation(database, {
    actorType: 'scheduler',
    command: 'metrics.capture',
    entityType: 'publication',
    entityId: input.publicationId,
    result: 'ok'
  });
  return success({
    id,
    publicationId: input.publicationId,
    scheduledFor: input.scheduledFor,
    capturedAt: input.capturedAt,
    sourceUrl: input.sourceUrl,
    normalized: input.normalized,
    raw: input.raw,
    createdAt: now
  });
}

export function failMetricJob(database: DatabaseSync, jobId: string, errorMessage: string): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
    .run(errorMessage, now, now, jobId);
}

export function failClaimedMetricJob(database: DatabaseSync, jobId: string, expectedAttempts: number, errorMessage: string, failedAt: string): CommandResult<MetricJob> {
  const changed = database.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND kind = 'publication_metrics' AND status = 'running' AND attempts = ?`)
    .run(errorMessage, failedAt, failedAt, jobId, expectedAttempts);
  if (Number(changed.changes ?? 0) !== 1) return failure('REVISION_CONFLICT', '指标任务失败身份已失效。');
  return success(parseJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow));
}

export function listPublicationMetricSnapshots(database: DatabaseSync, publicationId?: string): MetricSnapshot[] {
  const base = `SELECT id, publication_id AS publicationId, scheduled_for AS scheduledFor, captured_at AS capturedAt,
    source_url AS sourceUrl, normalized_json AS normalized, raw_json AS raw, created_at AS createdAt
    FROM publication_metric_snapshots`;
  const rows = (publicationId
    ? database.prepare(`${base} WHERE publication_id = ? ORDER BY captured_at DESC, scheduled_for DESC`).all(publicationId)
    : database.prepare(`${base} ORDER BY captured_at DESC, scheduled_for DESC`).all()) as Array<{
    id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string; normalized: string; raw: string; createdAt: string;
  }>;
  return rows.map((row) => ({
    ...row,
    normalized: JSON.parse(row.normalized),
    raw: JSON.parse(row.raw)
  }));
}

export function savePublicationMetricSnapshot(
  database: DatabaseSync,
  input: {
    publicationId: string;
    scheduledFor: string;
    sourceUrl: string;
    capturedAt: string;
    normalized: Record<string, unknown>;
    raw: Record<string, unknown>;
  },
  audit = true
): CommandResult<MetricSnapshot> {
  const publication = database.prepare(`SELECT id, status, external_url AS externalUrl FROM publications WHERE id = ?`)
    .get(input.publicationId) as { id: string; status: string; externalUrl: string | null } | undefined;
  if (!publication) return failure('NOT_FOUND', '发布记录不存在。');
  if (publication.status !== 'published' || !publication.externalUrl) {
    return failure('INVALID_STATE', '只有已发布且有 URL 的内容可以保存指标快照。');
  }
  const existing = database.prepare(`SELECT id FROM publication_metric_snapshots
    WHERE publication_id = ? AND scheduled_for = ?`).get(input.publicationId, input.scheduledFor) as { id: string } | undefined;
  if (existing) {
    const snapshot = database.prepare(`SELECT id, publication_id AS publicationId, scheduled_for AS scheduledFor, captured_at AS capturedAt,
      source_url AS sourceUrl, normalized_json AS normalized, raw_json AS raw, created_at AS createdAt
      FROM publication_metric_snapshots WHERE id = ?`).get(existing.id) as {
      id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string; normalized: string; raw: string; createdAt: string;
    };
    return success({
      ...snapshot,
      normalized: JSON.parse(snapshot.normalized),
      raw: JSON.parse(snapshot.raw)
    });
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`INSERT INTO publication_metric_snapshots (
    id, publication_id, scheduled_for, captured_at, source_url, normalized_json, raw_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.publicationId,
    input.scheduledFor,
    input.capturedAt,
    input.sourceUrl,
    JSON.stringify(input.normalized),
    JSON.stringify(input.raw),
    now
  );
  if (audit) recordOperation(database, {
    actorType: 'ui',
    command: 'metrics.capture_manual',
    entityType: 'publication',
    entityId: input.publicationId,
    result: 'ok'
  });
  return success({
    id,
    publicationId: input.publicationId,
    scheduledFor: input.scheduledFor,
    capturedAt: input.capturedAt,
    sourceUrl: input.sourceUrl,
    normalized: input.normalized,
    raw: input.raw,
    createdAt: now
  });
}

export type AccountMetricSnapshot = {
  id: string;
  accountId: string;
  platform: string;
  capturedAt: string;
  sourceUrl: string;
  normalized: Record<string, unknown>;
  raw: Record<string, unknown>;
  createdAt: string;
};

export function saveAccountMetricSnapshot(
  database: DatabaseSync,
  input: {
    accountId: string;
    platform: string;
    sourceUrl: string;
    capturedAt: string;
    normalized: Record<string, unknown>;
    raw: Record<string, unknown>;
  },
  audit = true
): CommandResult<AccountMetricSnapshot> {
  const account = database.prepare('SELECT id, platform FROM platform_accounts WHERE id = ?').get(input.accountId) as { id: string; platform: string } | undefined;
  if (!account) return failure('NOT_FOUND', '平台账号不存在。');
  if (account.platform !== input.platform) return failure('ACCOUNT_MISMATCH', '账号平台与采集平台不一致。');
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`INSERT INTO account_metric_snapshots (
    id, account_id, platform, captured_at, source_url, normalized_json, raw_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.accountId,
    input.platform,
    input.capturedAt,
    input.sourceUrl,
    JSON.stringify(input.normalized),
    JSON.stringify(input.raw),
    now
  );
  if (audit) recordOperation(database, {
    actorType: 'ui',
    command: 'metrics.account_capture',
    entityType: 'platform_account',
    entityId: input.accountId,
    result: 'ok'
  });
  return success({
    id,
    accountId: input.accountId,
    platform: input.platform,
    capturedAt: input.capturedAt,
    sourceUrl: input.sourceUrl,
    normalized: input.normalized,
    raw: input.raw,
    createdAt: now
  });
}

export function listAccountMetricSnapshots(database: DatabaseSync, accountId?: string): AccountMetricSnapshot[] {
  const rows = accountId
    ? database.prepare(`SELECT id, account_id AS accountId, platform, captured_at AS capturedAt, source_url AS sourceUrl,
        normalized_json AS normalized, raw_json AS raw, created_at AS createdAt
        FROM account_metric_snapshots WHERE account_id = ? ORDER BY captured_at DESC`).all(accountId) as Array<{
        id: string; accountId: string; platform: string; capturedAt: string; sourceUrl: string; normalized: string; raw: string; createdAt: string;
      }>
    : database.prepare(`SELECT id, account_id AS accountId, platform, captured_at AS capturedAt, source_url AS sourceUrl,
        normalized_json AS normalized, raw_json AS raw, created_at AS createdAt
        FROM account_metric_snapshots ORDER BY captured_at DESC`).all() as Array<{
        id: string; accountId: string; platform: string; capturedAt: string; sourceUrl: string; normalized: string; raw: string; createdAt: string;
      }>;
  return rows.map((row) => ({
    ...row,
    normalized: JSON.parse(row.normalized),
    raw: JSON.parse(row.raw)
  }));
}

export function scheduleJobsForPublishedPublications(database: DatabaseSync): number {
  const rows = database.prepare(`SELECT id, platform, external_url AS externalUrl, published_at AS publishedAt
    FROM publications WHERE status = 'published' AND external_url IS NOT NULL AND published_at IS NOT NULL`).all() as Array<{
    id: string; platform: string; externalUrl: string; publishedAt: string;
  }>;
  let created = 0;
  for (const row of rows) {
    const result = schedulePublicationMetricJobs(database, {
      publicationId: row.id,
      publishedAt: row.publishedAt,
      sourceUrl: row.externalUrl,
      platform: row.platform
    });
    if (result.ok) created += result.data.created;
  }
  return created;
}

export async function processDueMetricJobs(
  database: DatabaseSync,
  collect: (platform: string, sourceUrl: string) => Promise<{ sourceUrl: string; capturedAt: string; normalized: Record<string, unknown>; raw: Record<string, unknown> }>
): Promise<{ processed: number; snapshots: MetricSnapshot[] }> {
  const due = claimDueMetricJobs(database);
  const snapshots: MetricSnapshot[] = [];
  for (const job of due) {
    const publicationId = String(job.payload.publicationId ?? '');
    const sourceUrl = String(job.payload.sourceUrl ?? '');
    const scheduledFor = String(job.payload.scheduledFor ?? job.dueAt);
    const platform = String(job.payload.platform ?? '');
    try {
      const capture = await collect(platform, sourceUrl);
      const saved = completeMetricJob(database, {
        jobId: job.id,
        publicationId,
        scheduledFor,
        sourceUrl: capture.sourceUrl,
        capturedAt: capture.capturedAt,
        normalized: capture.normalized,
        raw: capture.raw
      });
      if (saved.ok) snapshots.push(saved.data);
      else failMetricJob(database, job.id, saved.error.message);
    } catch (error) {
      failMetricJob(database, job.id, error instanceof Error ? error.message : String(error));
    }
  }
  return { processed: due.length, snapshots };
}
