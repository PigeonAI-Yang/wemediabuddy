/**
 * WMB-5269：Source 正文自动归档（持久任务 + Worker + 失败读模型 + 重试）。
 * Design: docs/spark/2026-08-15-automatic-source-body-archive-design.md §6-§13。
 *
 * 职责：
 * - scheduleSourceBodyArchive：统一入库边界登记正文任务（幂等 job_key = `source:<id>:r<revision>`）。
 *   结构化完整文本在同一持久化边界立即固化（writeSourceBodyCache ready → succeeded job）；
 *   URL-only 创建 pending job 由 Worker 异步安全抓取；两者皆无 → 终态 unavailable(NO_BODY_SOURCE)。
 * - SourceBodyArchiveScheduler：启动恢复孤儿 running（租约超时 → pending）+ 历史补抓（水位可恢复、
 *   每次 1 页）+ 到期任务执行（new_source 优先；historical_backfill 至多 1 个 claim/分钟）。
 * - 抓取统一走 website-channel.fetchWebText（SSRF/DNS 重绑定/逐跳重定向/2MiB/类型/超时安全），
 *   自动周期至多 3 次实际尝试，退避 + 抖动；第三次失败 → needs_review，不再自动请求。
 * - listSourceBodyCaptureFailures / listSourceBodyCaptureAttempts / retrySourceBodyCaptureFailures：
 *   资料库「采集异常」读模型与重试（retryable=false 的项绝不进入 reason/all 批量重试）。
 *
 * 不变量：
 * - 正文真源仍是 source_body_revisions（不可变）+ source_body_cache（最新投影）；本模块不建第二套真源。
 * - 任务登记失败会随调用方事务回滚（同一持久化边界）；抓取失败永不回滚已保存的 Source。
 * - 正文捕获与 Pi 完全解耦（无 Pi 依赖）。
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  fetchWebText,
  errorCode,
  errorMessage,
  isTextResponse,
  looksLikeChallenge,
  type WebFetchedText
} from './website-channel.ts';
import {
  writeSourceBodyCache,
  getSourceBodyCache,
  extractReadableText,
  type SourceBodyCacheRecord
} from './source-body-cache.ts';
import { canonicalizeUrl } from './sources.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import { broadcastDataChanged } from './data-changed.ts';
import { scheduleSourceKnowledgeCompile } from './knowledge-compile-trigger.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import {
  SOURCE_BODY_REASON_CATEGORIES,
  type SourceBodyCaptureAttempt,
  type SourceBodyCaptureFailure,
  type SourceBodyCaptureFailureListInput,
  type SourceBodyCaptureFailureListResult,
  type SourceBodyCaptureJobStatus,
  type SourceBodyCapturePriority,
  type SourceBodyCaptureRetryInput,
  type SourceBodyCaptureRetryResult,
  type SourceBodyFetchMethod,
  type SourceBodyReasonCategory
} from '../shared/source-body-archive.ts';

// ============================================================
// 常量与限额（设计 §8/§9）
// ============================================================

/** 自动尝试上限（设计 §9：一次自动周期最多 3 次实际尝试）。 */
export const SOURCE_BODY_MAX_ATTEMPTS = 3;
/** Worker 有界并发（设计 §8：有界并发；轻量文本抓取取 2）。 */
export const SOURCE_BODY_ARCHIVE_CONCURRENCY = 2;
/** 历史补抓 claim 限速（设计 §13：至多 1 个/分钟）。 */
export const SOURCE_BODY_BACKFILL_CLAIM_INTERVAL_MS = 60_000;
/** 孤儿 running 租约窗口（设计 §8：超过租约时间回收为 pending）。 */
export const SOURCE_BODY_STALE_RUNNING_MS = 15 * 60 * 1000;
/** 历史补抓单页登记上限（设计 §13：分页登记，避免一次事务装载全部历史记录）。 */
export const SOURCE_BODY_BACKFILL_PAGE_SIZE = 100;
/** 抓取超时（与既有正文抓取一致）。 */
export const SOURCE_BODY_FETCH_TIMEOUT_MS = 20_000;
/** 正文字符上限（与既有 fetchAndCacheSourceBody 默认一致）。 */
export const SOURCE_BODY_MAX_CHARS = 20_000;
/** 失败重试退避：attempt 为已完成执行序号（1-based）。 */
export function sourceBodyRetryBackoffMs(attempt: number): number {
  const base = 120_000 * 8 ** Math.max(0, attempt - 1); // attempt1 ≈ 2min，attempt2 ≈ 16min
  const capped = Math.min(base, 3_600_000);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitter);
}

const BACKFILL_CURSOR_KEY = 'source_body_backfill_cursor';
const PAUSE_KEY = 'source_body_archive_paused';
const TERMINAL_FAILURE_STATUSES: ReadonlyArray<SourceBodyCaptureJobStatus> = ['needs_review', 'unavailable'];
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

const schedulerActor = Object.freeze({ type: 'scheduler', id: 'source-body-archive', label: 'source-body-archive' }) as { type: 'scheduler'; id: string; label: string };

export const SOURCE_BODY_ARCHIVE_CLAIM_COMMAND = 'source_body_archive.claim_job' as const;
export const SOURCE_BODY_ARCHIVE_FINISH_COMMAND = 'source_body_archive.finish_job' as const;

// ============================================================
// 基础工具
// ============================================================

/** 幂等键（设计 §6）：`source:<sourceId>:r<revision>`。 */
export function sourceBodyJobKey(sourceId: string, sourceRevision: number): string {
  return `source:${sourceId}:r${sourceRevision}`;
}

function workspaceIdOf(database: DatabaseSync): string {
  const row = database.prepare("SELECT value FROM app_meta WHERE key = 'workspace_id'").get() as { value?: string } | undefined;
  return row?.value ?? '';
}

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** 由 Source feed 归属推导正文渠道（与媒体归档 deriveDiscoveryChannel 同口径；不引入大模块依赖）。 */
function bodyChannelOf(database: DatabaseSync, feedId: string | null): string | null {
  if (!feedId) return null;
  const row = database.prepare(`SELECT module FROM (
      SELECT 'official_web' AS module FROM website_sources WHERE source_feed_id = ?
      UNION ALL
      SELECT 'x_lists' AS module FROM x_list_bindings WHERE source_feed_id = ?
    ) LIMIT 1`).get(feedId, feedId) as { module: string } | undefined;
  return row?.module ?? null;
}

export type SourceBodyCaptureJobRow = Readonly<{
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceRevision: number;
  jobKey: string;
  priority: SourceBodyCapturePriority;
  status: SourceBodyCaptureJobStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  bodyCandidate: { text: string; contentType: string | null; origin: string | null } | null;
  url: string | null;
  channel: string | null;
  domain: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastHttpStatus: number | null;
  reasonCategory: SourceBodyReasonCategory | null;
  retryable: boolean;
  fetchMethod: SourceBodyFetchMethod | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

const JOB_SELECT = `SELECT
  id, workspace_id AS workspaceId, source_id AS sourceId, source_revision AS sourceRevision, job_key AS jobKey,
  priority, status, attempt_count AS attemptCount, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt,
  body_candidate AS bodyCandidate, url, channel, domain,
  last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage, last_http_status AS lastHttpStatus,
  reason_category AS reasonCategory, retryable, fetch_method AS fetchMethod,
  started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt, updated_at AS updatedAt
  FROM source_body_capture_jobs`;

function parseBodyCandidate(raw: unknown): SourceBodyCaptureJobRow['bodyCandidate'] {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; contentType?: unknown; origin?: unknown };
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
    return {
      text: parsed.text,
      contentType: typeof parsed.contentType === 'string' ? parsed.contentType : null,
      origin: typeof parsed.origin === 'string' ? parsed.origin : null
    };
  } catch {
    return null;
  }
}

function mapJobRow(row: Record<string, unknown>): SourceBodyCaptureJobRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId ?? ''),
    sourceId: String(row.sourceId),
    sourceRevision: Number(row.sourceRevision),
    jobKey: String(row.jobKey),
    priority: row.priority as SourceBodyCapturePriority,
    status: row.status as SourceBodyCaptureJobStatus,
    attemptCount: Number(row.attemptCount ?? 0),
    maxAttempts: Number(row.maxAttempts ?? SOURCE_BODY_MAX_ATTEMPTS),
    nextAttemptAt: String(row.nextAttemptAt),
    bodyCandidate: parseBodyCandidate(row.bodyCandidate),
    url: (row.url as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    domain: (row.domain as string | null) ?? null,
    lastErrorCode: (row.lastErrorCode as string | null) ?? null,
    lastErrorMessage: (row.lastErrorMessage as string | null) ?? null,
    lastHttpStatus: row.lastHttpStatus == null ? null : Number(row.lastHttpStatus),
    reasonCategory: (row.reasonCategory as SourceBodyReasonCategory | null) ?? null,
    retryable: Number(row.retryable ?? 1) === 1,
    fetchMethod: (row.fetchMethod as SourceBodyFetchMethod | null) ?? null,
    startedAt: (row.startedAt as string | null) ?? null,
    finishedAt: (row.finishedAt as string | null) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
}

function getJobByKey(database: DatabaseSync, jobKey: string): SourceBodyCaptureJobRow | null {
  const row = database.prepare(`${JOB_SELECT} WHERE job_key = ?`).get(jobKey) as Record<string, unknown> | undefined;
  return row ? mapJobRow(row) : null;
}

function getJob(database: DatabaseSync, jobId: string): SourceBodyCaptureJobRow | null {
  const row = database.prepare(`${JOB_SELECT} WHERE id = ?`).get(jobId) as Record<string, unknown> | undefined;
  return row ? mapJobRow(row) : null;
}

/** 同 source + 同 URL 的既有任务（跨 revision 复用，防 upsert 每次 revision 递增造成抓取风暴）。 */
function findJobBySourceAndUrl(database: DatabaseSync, sourceId: string, url: string): SourceBodyCaptureJobRow | null {
  const row = database.prepare(`${JOB_SELECT} WHERE source_id = ? AND url = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(sourceId, url) as Record<string, unknown> | undefined;
  return row ? mapJobRow(row) : null;
}

// ============================================================
// 登记（统一入库边界；调用方事务内执行；结构化文本立即固化）
// ============================================================

export type SourceBodyArchiveScheduleInput = Readonly<{
  sourceId: string;
  sourceRevision: number;
  url?: string | null;
  structuredText?: string | null;
  contentType?: string | null;
  origin?: string | null;
  channel?: string | null;
}>;

export type SourceBodyArchiveScheduleResult = Readonly<{
  jobId: string | null;
  status: SourceBodyCaptureJobStatus;
  created: boolean;
}>;

/**
 * 登记正文任务（设计 §6 统一入库边界；调用方事务内执行）：
 * - job_key 幂等：ready → 不创建；pending/running/retry_wait → 复用；终态失败 → 保持终态（人工重试除外）。
 * - 结构化完整文本：立即 writeSourceBodyCache(ready) + 创建 succeeded job（不请求原网页）。
 * - URL-only：创建 pending job（new_source；Worker 异步安全抓取）。
 * - 两者皆无：终态 unavailable(NO_BODY_SOURCE)。
 * - 已有 ready 正文且 URL 相同 → 不创建任务（已有成功正文不被无意义重抓）。
 */
export function scheduleSourceBodyArchive(
  database: DatabaseSync,
  input: SourceBodyArchiveScheduleInput
): SourceBodyArchiveScheduleResult {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new Error('SOURCE_ID_REQUIRED');
  const jobKey = sourceBodyJobKey(sourceId, input.sourceRevision);
  const now = new Date().toISOString();
  const workspaceId = workspaceIdOf(database);
  let url = input.url?.trim() || null;
  if (url) {
    try { url = canonicalizeUrl(url); } catch { url = null; }
  }
  const structuredText = input.structuredText?.trim() || null;
  const contentType = input.contentType?.trim() || null;
  const origin = input.origin?.trim() || null;
  const channel = input.channel?.trim() || null;

  // 结构化完整文本：同一持久化边界立即固化（设计 §2.4 / §7.1）。同 source+url 已有任务 → 复用并刷新为 ready。
  if (structuredText) {
    const record: SourceBodyCacheRecord = {
      sourceId,
      url: url ?? '',
      status: 'ready',
      contentType,
      extractedText: structuredText,
      extractedChars: structuredText.length,
      errorMessage: null,
      fetchedAt: now,
      updatedAt: now
    };
    writeSourceBodyCache(database, record);
    const existing = getJobByKey(database, jobKey) ?? (url ? findJobBySourceAndUrl(database, sourceId, url) : null);
    if (existing) {
      if (existing.status !== 'ready') {
        database.prepare(`UPDATE source_body_capture_jobs SET status = 'ready', fetch_method = 'channel_text',
          last_error_code = NULL, last_error_message = NULL, last_http_status = NULL, reason_category = NULL,
          retryable = 1, started_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, existing.id);
      }
      return { jobId: existing.id, status: 'ready', created: false };
    }
    const jobId = randomUUID();
    database.prepare(`INSERT INTO source_body_capture_jobs (
      id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts,
      next_attempt_at, body_candidate, url, channel, domain, last_error_code, last_error_message, last_http_status,
      reason_category, retryable, fetch_method, started_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'new_source', 'ready', 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 'channel_text', NULL, ?, ?, ?)`)
      .run(
        jobId, workspaceId, sourceId, input.sourceRevision, jobKey, SOURCE_BODY_MAX_ATTEMPTS, now,
        JSON.stringify({ text: structuredText, contentType, origin }), url, channel, domainOf(url), now, now, now
      );
    return { jobId, status: 'ready', created: true };
  }

  // URL-only：job_key 幂等重放；同 source+url 跨 revision 复用（防扫描 revision 递增导致重复抓取）。
  const existingByKey = getJobByKey(database, jobKey);
  if (existingByKey) {
    return { jobId: existingByKey.id, status: existingByKey.status, created: false };
  }
  if (url) {
    const existingByUrl = findJobBySourceAndUrl(database, sourceId, url);
    if (existingByUrl) {
      return { jobId: existingByUrl.id, status: existingByUrl.status, created: false };
    }
    // 已有 ready 正文且 URL 相同 → 不创建任务（设计 §6「已有 ready 正文：不创建任务」）。
    const cache = getSourceBodyCache(database, sourceId);
    if (cache && cache.status === 'ready' && cache.extractedText.trim() && cache.url === url) {
      return { jobId: null, status: 'ready', created: false };
    }
    const jobId = randomUUID();
    database.prepare(`INSERT INTO source_body_capture_jobs (
      id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts,
      next_attempt_at, body_candidate, url, channel, domain, last_error_code, last_error_message, last_http_status,
      reason_category, retryable, fetch_method, started_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'new_source', 'pending', 0, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 'static_http', NULL, NULL, ?, ?)`)
      .run(
        jobId, workspaceId, sourceId, input.sourceRevision, jobKey, SOURCE_BODY_MAX_ATTEMPTS, now,
        url, channel, domainOf(url), now, now
      );
    return { jobId, status: 'pending', created: true };
  }

  // 无正文来源（设计 §7.3）：终态 unavailable，原因码 NO_BODY_SOURCE（不自动重试）。
  const existingTerminal = getJobByKey(database, jobKey);
  if (existingTerminal) {
    return { jobId: existingTerminal.id, status: existingTerminal.status, created: false };
  }
  const jobId = randomUUID();
  database.prepare(`INSERT INTO source_body_capture_jobs (
    id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts,
    next_attempt_at, body_candidate, url, channel, domain, last_error_code, last_error_message, last_http_status,
    reason_category, retryable, fetch_method, started_at, finished_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'new_source', 'unavailable', 0, ?, ?, NULL, NULL, ?, NULL, 'NO_BODY_SOURCE', ?, NULL, 'no_source', 0, 'none', NULL, ?, ?, ?)`)
    .run(
      jobId, workspaceId, sourceId, input.sourceRevision, jobKey, SOURCE_BODY_MAX_ATTEMPTS, now,
      channel, '缺少完整文本且没有可抓取原文链接。', now, now, now
    );
  return { jobId, status: 'unavailable', created: true };
}

// ============================================================
// 全局暂停（设计 §13：暂停时新增与历史任务一并停 claim）
// ============================================================

export function isSourceBodyArchivePaused(database: DatabaseSync): boolean {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(PAUSE_KEY) as { value?: string } | undefined;
  return row?.value === '1';
}

export function setSourceBodyArchivePaused(database: DatabaseSync, paused: boolean): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, revision = app_meta.revision + 1`)
    .run(PAUSE_KEY, paused ? '1' : '0', now, now);
}

// ============================================================
// Worker 执行（claim/finish 经 dispatchBusinessCommand 授权；抓取在事务外）
// ============================================================

export type SourceBodyArchiveWorkerDeps = Readonly<{
  fetchImpl?: typeof fetch;
  lookupImpl?: Parameters<typeof fetchWebText>[0]['lookupImpl'];
  now?: () => Date;
}>;

export type BodyCaptureOutcome =
  | { outcome: 'ready'; record: SourceBodyCacheRecord; fetchMethod: SourceBodyFetchMethod; retryAfterSeconds: number | null; finalUrl: string | null; hops: string[] }
  | { outcome: 'failed' | 'unavailable'; code: string; message: string; retryable: boolean; fetchMethod: SourceBodyFetchMethod; httpStatus: number | null; retryAfterSeconds: number | null };

// ---- 原因分类（设计 §11 标准码 → §12 聚合分类） ----

const REASON_CATEGORY_BY_CODE: Readonly<Record<string, SourceBodyReasonCategory>> = {
  URL_SECURITY_BLOCKED: 'security',
  URL_INVALID: 'security',
  HTTP_UNAUTHORIZED: 'auth',
  HTTP_FORBIDDEN: 'auth',
  HTTP_NOT_FOUND: 'http',
  HTTP_GONE: 'http',
  HTTP_RATE_LIMITED: 'http',
  NETWORK_TIMEOUT: 'network',
  NETWORK_ERROR: 'network',
  LOGIN_REQUIRED: 'auth',
  CAPTCHA_DETECTED: 'auth',
  DYNAMIC_PAGE_EMPTY: 'content',
  EXTRACTION_EMPTY: 'content',
  CONTENT_TYPE_UNSUPPORTED: 'content',
  RESPONSE_TOO_LARGE: 'content',
  NO_BODY_SOURCE: 'no_source',
  UNKNOWN_ERROR: 'unknown'
};

/** 默认不可自动重试（设计 §9）：安全拦截 / 明确失效 / 登录验证码授权 / 政策禁止 / 缺源。 */
const NON_RETRYABLE_CODES = new Set([
  'URL_SECURITY_BLOCKED',
  'URL_INVALID',
  'HTTP_UNAUTHORIZED',
  'HTTP_FORBIDDEN',
  'HTTP_NOT_FOUND',
  'HTTP_GONE',
  'LOGIN_REQUIRED',
  'CAPTCHA_DETECTED',
  'DYNAMIC_PAGE_EMPTY',
  'CONTENT_TYPE_UNSUPPORTED',
  'RESPONSE_TOO_LARGE',
  'NO_BODY_SOURCE'
]);

function reasonCategoryOf(code: string): SourceBodyReasonCategory {
  return REASON_CATEGORY_BY_CODE[code] ?? 'unknown';
}

function isRetryableCode(code: string): boolean {
  return !NON_RETRYABLE_CODES.has(code);
}

/** fetchWebText 抛出的 WebsiteChannelError → 结构化原因码。 */
function mapFetchError(error: unknown): { code: string; message: string } {
  const code = errorCode(error, 'UNKNOWN_ERROR');
  switch (code) {
    case 'WEBSITE_URL_NOT_PUBLIC':
    case 'WEBSITE_DNS_REBINDING':
      return { code: 'URL_SECURITY_BLOCKED', message: errorMessage(error) };
    case 'WEBSITE_DNS_FAILED':
    case 'WEBSITE_NETWORK_FAILED':
      return { code: 'NETWORK_ERROR', message: errorMessage(error) };
    case 'WEBSITE_TIMEOUT':
      return { code: 'NETWORK_TIMEOUT', message: '网页读取超过时限。' };
    case 'WEBSITE_REDIRECT_LIMIT':
    case 'WEBSITE_REDIRECT_INVALID':
    case 'WEBSITE_REDIRECT_PROTOCOL':
      return { code: 'URL_SECURITY_BLOCKED', message: errorMessage(error) };
    case 'WEBSITE_BODY_TOO_LARGE':
      return { code: 'RESPONSE_TOO_LARGE', message: errorMessage(error) };
    case 'WEBSITE_CONTENT_TYPE_UNSUPPORTED':
      return { code: 'CONTENT_TYPE_UNSUPPORTED', message: errorMessage(error) };
    case 'WEBSITE_NEEDS_USER':
      return { code: 'LOGIN_REQUIRED', message: errorMessage(error) };
    default:
      return { code: 'UNKNOWN_ERROR', message: errorMessage(error) };
  }
}

function httpStatusOutcome(status: number, body: string, contentType: string | null): BodyCaptureOutcome {
  const fetchMethod: SourceBodyFetchMethod = 'static_http';
  if (looksLikeChallenge(body)) {
    return { outcome: 'failed', code: 'CAPTCHA_DETECTED', message: '网站要求登录、验证或通过反自动化挑战。', retryable: false, fetchMethod, httpStatus: status, retryAfterSeconds: null };
  }
  switch (status) {
    case 401:
      return { outcome: 'failed', code: 'HTTP_UNAUTHORIZED', message: `抓取失败 HTTP ${status}。`, retryable: false, fetchMethod, httpStatus: status, retryAfterSeconds: null };
    case 403:
      return { outcome: 'failed', code: 'HTTP_FORBIDDEN', message: `抓取失败 HTTP ${status}。`, retryable: false, fetchMethod, httpStatus: status, retryAfterSeconds: null };
    case 404:
      return { outcome: 'failed', code: 'HTTP_NOT_FOUND', message: `抓取失败 HTTP ${status}。`, retryable: false, fetchMethod, httpStatus: status, retryAfterSeconds: null };
    case 410:
      return { outcome: 'failed', code: 'HTTP_GONE', message: `抓取失败 HTTP ${status}。`, retryable: false, fetchMethod, httpStatus: status, retryAfterSeconds: null };
    case 429:
      return { outcome: 'failed', code: 'HTTP_RATE_LIMITED', message: `抓取失败 HTTP ${status}（限流）。`, retryable: true, fetchMethod, httpStatus: status, retryAfterSeconds: null };
    default:
      if (status >= 500) {
        return { outcome: 'failed', code: 'NETWORK_ERROR', message: `抓取失败 HTTP ${status}。`, retryable: true, fetchMethod, httpStatus: status, retryAfterSeconds: null };
      }
      return { outcome: 'failed', code: 'UNKNOWN_ERROR', message: `抓取失败 HTTP ${status}。`, retryable: true, fetchMethod, httpStatus: status, retryAfterSeconds: null };
  }
}

function contentTypeSupported(contentType: string | null, body: string): boolean {
  const type = (contentType || '').toLowerCase();
  if (isTextResponse(contentType, body)) return true;
  return /(?:^|;)\s*(application\/(?:json|xml|javascript)|text\/[\w+.-]*)(?:;|$)/.test(type) || false;
}

/** 执行一次捕获（事务外；仅 fetchWebText 安全抓取，无裸 fetch）。 */
export async function executeSourceBodyCapture(
  database: DatabaseSync,
  job: SourceBodyCaptureJobRow,
  deps: SourceBodyArchiveWorkerDeps = {}
): Promise<BodyCaptureOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const maxChars = SOURCE_BODY_MAX_CHARS;

  // 冻结的完整渠道文本（设计 §7.1 优先级 1）：直接固化，不请求原网页。
  if (job.bodyCandidate) {
    return {
      outcome: 'ready',
      record: {
        sourceId: job.sourceId,
        url: job.url ?? '',
        status: 'ready',
        contentType: job.bodyCandidate.contentType,
        extractedText: job.bodyCandidate.text,
        extractedChars: job.bodyCandidate.text.length,
        errorMessage: null,
        fetchedAt: now.toISOString(),
        updatedAt: now.toISOString()
      },
      fetchMethod: 'channel_text',
      retryAfterSeconds: null,
      finalUrl: job.url ?? null,
      hops: []
    };
  }

  if (!job.url) {
    return {
      outcome: 'unavailable',
      code: 'NO_BODY_SOURCE',
      message: '缺少完整文本且没有可抓取原文链接。',
      retryable: false,
      fetchMethod: 'none',
      httpStatus: null,
      retryAfterSeconds: null
    };
  }

  let fetched: WebFetchedText;
  try {
    fetched = await fetchWebText({
      url: job.url,
      signal: AbortSignal.timeout(SOURCE_BODY_FETCH_TIMEOUT_MS),
      fetchImpl: deps.fetchImpl,
      lookupImpl: deps.lookupImpl
    });
  } catch (error) {
    const mapped = mapFetchError(error);
    return {
      outcome: 'failed',
      code: mapped.code,
      message: mapped.message,
      retryable: isRetryableCode(mapped.code),
      fetchMethod: 'static_http',
      httpStatus: null,
      retryAfterSeconds: null
    };
  }

  if (fetched.status !== 200) {
    const outcome = httpStatusOutcome(fetched.status, fetched.body, fetched.contentType);
    return { ...outcome, retryAfterSeconds: fetched.retryAfterSeconds ?? null };
  }
  if (!contentTypeSupported(fetched.contentType, fetched.body)) {
    return {
      outcome: 'failed',
      code: 'CONTENT_TYPE_UNSUPPORTED',
      message: `不支持的内容类型：${fetched.contentType || 'unknown'}。`,
      retryable: false,
      fetchMethod: 'static_http',
      httpStatus: fetched.status,
      retryAfterSeconds: fetched.retryAfterSeconds ?? null
    };
  }
  if (looksLikeChallenge(fetched.body)) {
    return {
      outcome: 'failed',
      code: 'CAPTCHA_DETECTED',
      message: '网站要求登录、验证或通过反自动化挑战。',
      retryable: false,
      fetchMethod: 'static_http',
      httpStatus: fetched.status,
      retryAfterSeconds: fetched.retryAfterSeconds ?? null
    };
  }

  const extracted = extractReadableText(fetched.body, fetched.contentType, maxChars).trim();
  if (!extracted) {
    return {
      outcome: 'failed',
      code: 'EXTRACTION_EMPTY',
      message: '页面没有提取到可读正文。',
      retryable: true,
      fetchMethod: 'static_http',
      httpStatus: fetched.status,
      retryAfterSeconds: fetched.retryAfterSeconds ?? null
    };
  }

  return {
    outcome: 'ready',
    record: {
      sourceId: job.sourceId,
      url: job.url ?? fetched.finalUrl ?? '',
      status: 'ready',
      contentType: fetched.contentType,
      extractedText: extracted,
      extractedChars: extracted.length,
      errorMessage: null,
      fetchedAt: now.toISOString(),
      updatedAt: now.toISOString()
    },
    fetchMethod: 'static_http',
    retryAfterSeconds: fetched.retryAfterSeconds ?? null,
    finalUrl: fetched.finalUrl || job.url,
    hops: fetched.hops
  };
}

// ---- claim（调用方事务内） ----

export type BodyClaimResult =
  | { claimed: true; job: SourceBodyCaptureJobRow; attemptNumber: number }
  | { claimed: false; reason: 'STALE' | 'PAUSED' };

/** 乐观 claim：pending/retry_wait 到期 → running，attempt_count+1，写 running attempt 行。 */
export function claimSourceBodyJob(
  database: DatabaseSync,
  jobId: string,
  expectedAttempts: number,
  input: { now?: string } = {}
): BodyClaimResult {
  const now = input.now ?? new Date().toISOString();
  const updated = database.prepare(`UPDATE source_body_capture_jobs
    SET status = 'running', attempt_count = attempt_count + 1, started_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'retry_wait') AND attempt_count = ? AND next_attempt_at <= ?`)
    .run(now, now, jobId, expectedAttempts, now);
  if (Number(updated.changes ?? 0) !== 1) return { claimed: false, reason: 'STALE' };
  const job = getJob(database, jobId);
  if (!job) return { claimed: false, reason: 'STALE' };
  database.prepare(`INSERT INTO source_body_capture_attempts (
    id, job_id, attempt_number, status, fetch_method, started_at
  ) VALUES (?, ?, ?, 'running', ?, ?)`)
    .run(randomUUID(), jobId, job.attemptCount, job.fetchMethod ?? 'static_http', now);
  return { claimed: true, job, attemptNumber: job.attemptCount };
}

// ---- finish（调用方事务内） ----

export type BodyFinishResult = Readonly<{
  finished: boolean;
  stale: boolean;
  jobStatus: SourceBodyCaptureJobStatus;
}>;

/** 完成一次捕获：成功 → 固化正文（writeSourceBodyCache ready）+ job ready；失败 → 退避重排或终态。 */
export function finishSourceBodyJob(
  database: DatabaseSync,
  input: {
    jobId: string;
    expectedAttempts: number;
    outcome: BodyCaptureOutcome;
    now?: string;
  }
): BodyFinishResult {
  const now = input.now ?? new Date().toISOString();
  const job = getJob(database, input.jobId);
  if (!job || job.status !== 'running' || job.attemptCount !== input.expectedAttempts) {
    return { finished: false, stale: true, jobStatus: job?.status ?? 'pending' };
  }

  const writeAttempt = (status: 'succeeded' | 'failed', extra: Partial<Record<string, SQLInputValue>> = {}) => {
    database.prepare(`UPDATE source_body_capture_attempts SET
      status = ?, finished_at = ?, error_code = ?, error_message = ?, http_status = ?, fetch_method = ?,
      content_type = ?, requested_url = ?, final_url = ?, redirect_chain = ?, extracted_chars = ?
      WHERE job_id = ? AND attempt_number = ?`)
      .run(
        status, now,
        extra.errorCode ?? null, extra.errorMessage ?? null, extra.httpStatus ?? null,
        extra.fetchMethod ?? job.fetchMethod ?? 'static_http',
        extra.contentType ?? null, extra.requestedUrl ?? null, extra.finalUrl ?? null,
        extra.redirectChain ?? null, extra.extractedChars ?? null,
        input.jobId, job.attemptCount
      );
  };

  if (input.outcome.outcome === 'ready') {
    writeSourceBodyCache(database, input.outcome.record);
    writeAttempt('succeeded', {
      fetchMethod: input.outcome.fetchMethod,
      contentType: input.outcome.record.contentType,
      requestedUrl: job.url ?? null,
      finalUrl: input.outcome.finalUrl ?? null,
      redirectChain: input.outcome.hops.length ? JSON.stringify(input.outcome.hops) : null,
      extractedChars: input.outcome.record.extractedChars
    });
    database.prepare(`UPDATE source_body_capture_jobs SET
      status = 'ready', fetch_method = ?, last_error_code = NULL, last_error_message = NULL, last_http_status = NULL,
      reason_category = NULL, retryable = 1, started_at = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`)
      .run(input.outcome.fetchMethod, now, now, input.jobId);
    return { finished: true, stale: false, jobStatus: 'ready' };
  }

  const { code, message, retryable, fetchMethod, httpStatus, retryAfterSeconds } = input.outcome;
  const exhausted = job.attemptCount >= job.maxAttempts;
  writeAttempt('failed', { errorCode: code, errorMessage: message, httpStatus, fetchMethod });

  if (retryable && !exhausted) {
    // 退避重排（设计 §9）：Retry-After 存在时不得早于系统退避下限。
    const backoffMs = sourceBodyRetryBackoffMs(job.attemptCount);
    const retryAfterMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 0;
    const delay = Math.max(backoffMs, retryAfterMs);
    const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
    database.prepare(`UPDATE source_body_capture_jobs SET
      status = 'retry_wait', next_attempt_at = ?, last_error_code = ?, last_error_message = ?, last_http_status = ?,
      reason_category = ?, retryable = ?, started_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'`)
      .run(nextAttemptAt, code, message, httpStatus, reasonCategoryOf(code), retryable ? 1 : 0, now, input.jobId);
    return { finished: true, stale: false, jobStatus: 'retry_wait' };
  }

  // 终态：失败耗尽（needs_review）或缺源（unavailable）；失败不覆盖最后成功正文投影（writeSourceBodyCache 语义）。
  const terminalStatus: SourceBodyCaptureJobStatus = code === 'NO_BODY_SOURCE' ? 'unavailable' : 'needs_review';
  if (code !== 'NO_BODY_SOURCE') {
    writeSourceBodyCache(database, {
      sourceId: job.sourceId,
      url: job.url ?? '',
      status: code === 'EXTRACTION_EMPTY' ? 'empty' : 'failed',
      contentType: null,
      extractedText: '',
      extractedChars: 0,
      errorMessage: message,
      fetchedAt: now,
      updatedAt: now
    });
  }
  database.prepare(`UPDATE source_body_capture_jobs SET
    status = ?, last_error_code = ?, last_error_message = ?, last_http_status = ?,
    reason_category = ?, retryable = ?, started_at = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'`)
    .run(terminalStatus, code, message, httpStatus, reasonCategoryOf(code), retryable ? 1 : 0, now, now, input.jobId);
  return { finished: true, stale: false, jobStatus: terminalStatus };
}

// ---- 启动恢复（孤儿 running → pending；attempt 上限内重试） ----

export function recoverInterruptedSourceBodyJobs(
  database: DatabaseSync,
  input: { staleAfterMs?: number; now?: string } = {}
): { recovered: number; exhausted: number } {
  const now = input.now ?? new Date().toISOString();
  const staleAfterMs = input.staleAfterMs ?? SOURCE_BODY_STALE_RUNNING_MS;
  const cutoff = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const rows = database.prepare(`${JOB_SELECT} WHERE status = 'running' AND updated_at <= ?`).all(cutoff) as Array<Record<string, unknown>>;
  let recovered = 0;
  let exhausted = 0;
  for (const row of rows) {
    const job = mapJobRow(row);
    database.prepare(`UPDATE source_body_capture_attempts SET
      status = 'failed', finished_at = ?, error_code = 'EXECUTION_INTERRUPTED', error_message = '执行中断超过 15 分钟（进程崩溃或暂停），已恢复。'
      WHERE job_id = ? AND attempt_number = ? AND status = 'running'`)
      .run(now, job.id, job.attemptCount);
    if (job.attemptCount < job.maxAttempts) {
      database.prepare(`UPDATE source_body_capture_jobs SET status = 'pending', next_attempt_at = ?,
        last_error_code = 'EXECUTION_INTERRUPTED', last_error_message = '执行中断，等待重试。',
        started_at = NULL, updated_at = ? WHERE id = ?`)
        .run(now, now, job.id);
      recovered += 1;
    } else {
      database.prepare(`UPDATE source_body_capture_jobs SET status = 'needs_review',
        last_error_code = 'EXECUTION_INTERRUPTED', last_error_message = '执行中断且已达自动尝试上限。',
        reason_category = 'unknown', retryable = 1, started_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, job.id);
      exhausted += 1;
    }
  }
  return { recovered, exhausted };
}

// ============================================================
// 历史补抓（设计 §13：倒序分页登记；水位持久化；不重复登记相同 revision）
// ============================================================

export type BackfillCursor = Readonly<{ collectedAt: string; id: string }>;

function readBackfillCursor(database: DatabaseSync): BackfillCursor | 'done' | 'not_started' {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(BACKFILL_CURSOR_KEY) as { value?: string } | undefined;
  const value = row?.value ?? 'not_started';
  if (value === 'done' || value === 'not_started') return value;
  try {
    const parsed = JSON.parse(value) as { collectedAt?: unknown; id?: unknown };
    if (typeof parsed.collectedAt === 'string' && typeof parsed.id === 'string') {
      return { collectedAt: parsed.collectedAt, id: parsed.id };
    }
  } catch {
    // 损坏水位：从头开始。
  }
  return 'not_started';
}

function writeBackfillCursor(database: DatabaseSync, cursor: BackfillCursor | 'done'): void {
  const now = new Date().toISOString();
  const value = cursor === 'done' ? 'done' : JSON.stringify(cursor);
  database.prepare(`INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, revision = app_meta.revision + 1`)
    .run(BACKFILL_CURSOR_KEY, value, now, now);
}

/**
 * 历史补抓单页登记（调用方事务内）：无 ready 正文的非归档 Source，按 collected_at DESC 倒序，
 * keyset 分页（pageSize 上限）；已存在同 revision job 的行跳过（不重复登记）。
 * 返回 { registered, done }：done=true 表示已扫完全量候选（水位 'done'）。
 */
export function runSourceBodyBackfillPage(
  database: DatabaseSync,
  input: { pageSize?: number; now?: string } = {}
): { registered: number; done: boolean } {
  const cursor = readBackfillCursor(database);
  if (cursor === 'done') return { registered: 0, done: true };
  const pageSize = Math.min(Math.max(input.pageSize ?? SOURCE_BODY_BACKFILL_PAGE_SIZE, 1), 500);
  const now = input.now ?? new Date().toISOString();
  const workspaceId = workspaceIdOf(database);

  const where = cursor === 'not_started'
    ? `AND s.management_status != 'archived'
       AND NOT EXISTS (SELECT 1 FROM source_body_revisions r WHERE r.source_id = s.id AND r.status = 'ready' AND length(r.extracted_text) > 0)
       AND (s.canonical_url IS NOT NULL OR s.original_url IS NOT NULL)`
    : `AND s.management_status != 'archived'
       AND NOT EXISTS (SELECT 1 FROM source_body_revisions r WHERE r.source_id = s.id AND r.status = 'ready' AND length(r.extracted_text) > 0)
       AND (s.canonical_url IS NOT NULL OR s.original_url IS NOT NULL)
       AND (s.collected_at < ? OR (s.collected_at = ? AND s.id < ?))`;
  const params = cursor === 'not_started' ? [] : [cursor.collectedAt, cursor.collectedAt, cursor.id];
  const rows = database.prepare(`SELECT s.id AS id, s.revision AS revision, s.collected_at AS collectedAt,
    s.canonical_url AS canonicalUrl, s.original_url AS originalUrl, s.feed_id AS feedId
    FROM source_items s
    WHERE 1 = 1 ${where}
    ORDER BY s.collected_at DESC, s.id DESC
    LIMIT ?`).all(...params, pageSize + 1) as Array<Record<string, unknown>>;

  const page = rows.length > pageSize ? rows.slice(0, pageSize) : rows;
  let registered = 0;
  for (const row of page) {
    const sourceId = String(row.id);
    const revision = Number(row.revision);
    const jobKey = sourceBodyJobKey(sourceId, revision);
    const existing = database.prepare('SELECT id FROM source_body_capture_jobs WHERE job_key = ?').get(jobKey);
    if (existing) continue;
    const url = String(row.canonicalUrl ?? row.originalUrl ?? '');
    const channel = bodyChannelOf(database, (row.feedId as string | null) ?? null);
    database.prepare(`INSERT INTO source_body_capture_jobs (
      id, workspace_id, source_id, source_revision, job_key, priority, status, attempt_count, max_attempts,
      next_attempt_at, body_candidate, url, channel, domain, last_error_code, last_error_message, last_http_status,
      reason_category, retryable, fetch_method, started_at, finished_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'historical_backfill', 'pending', 0, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 'static_http', NULL, NULL, ?, ?)`)
      .run(
        randomUUID(), workspaceId, sourceId, revision, jobKey, SOURCE_BODY_MAX_ATTEMPTS, now,
        url, channel, domainOf(url), now, now
      );
    registered += 1;
  }

  if (page.length === 0) {
    writeBackfillCursor(database, 'done');
    return { registered, done: true };
  }
  const last = page[page.length - 1];
  // 末页不满页 → 已扫完全量候选：直接落 done 水位（重启后不再扫）。
  if (page.length < pageSize) {
    writeBackfillCursor(database, 'done');
    return { registered, done: true };
  }
  writeBackfillCursor(database, { collectedAt: String(last.collectedAt), id: String(last.id) });
  return { registered, done: false };
}

// ============================================================
// 失败读模型（设计 §12 异常中心）
// ============================================================

const FAILURE_SELECT = `SELECT j.id AS jobId, j.source_id AS sourceId, COALESCE(s.title, '') AS title,
  j.url AS url, j.attempt_count AS attempts, j.last_error_code AS errorCode, j.last_error_message AS errorMessage,
  j.reason_category AS reasonCategory, j.retryable AS retryable, j.finished_at AS failedAt,
  j.domain AS domain, j.channel AS channel, j.fetch_method AS fetchMethod, j.last_http_status AS lastHttpStatus
  FROM source_body_capture_jobs j
  JOIN source_items s ON s.id = j.source_id`;

/**
 * 失败列表（分页 keyset：finished_at DESC, id DESC；cursor 为上一页最后一条 jobId）。
 * 只返回终态失败行（needs_review / unavailable）；reasonCategory 可选过滤。
 */
export function listSourceBodyCaptureFailures(
  database: DatabaseSync,
  input: SourceBodyCaptureFailureListInput = {}
): SourceBodyCaptureFailureListResult {
  const limit = Math.min(Math.max(input.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const workspaceId = workspaceIdOf(database);
  const statuses = TERMINAL_FAILURE_STATUSES.map(() => '?').join(', ');
  let sql = `${FAILURE_SELECT}
    WHERE j.workspace_id = ? AND j.status IN (${statuses})`;
  const params: SQLInputValue[] = [workspaceId, ...TERMINAL_FAILURE_STATUSES];
  if (input.reasonCategory) {
    sql += ' AND j.reason_category = ?';
    params.push(input.reasonCategory);
  }
  if (input.cursor) {
    sql += ' AND (j.finished_at < (SELECT finished_at FROM source_body_capture_jobs WHERE id = ?) OR (j.finished_at = (SELECT finished_at FROM source_body_capture_jobs WHERE id = ?) AND j.id < ?))';
    params.push(input.cursor, input.cursor, input.cursor);
  }
  sql += ' ORDER BY j.finished_at DESC, j.id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = database.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const items: SourceBodyCaptureFailure[] = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
    jobId: String(row.jobId),
    sourceId: String(row.sourceId),
    title: String(row.title),
    url: (row.url as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    errorCode: (row.errorCode as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    reasonCategory: (row.reasonCategory as SourceBodyReasonCategory | null) ?? null,
    retryable: Number(row.retryable ?? 0) === 1,
    failedAt: String(row.failedAt ?? ''),
    domain: (row.domain as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    fetchMethod: (row.fetchMethod as SourceBodyFetchMethod | null) ?? null,
    lastHttpStatus: row.lastHttpStatus == null ? null : Number(row.lastHttpStatus)
  }));
  return { items, nextCursor: hasMore ? items[items.length - 1].jobId : null };
}

/** 单条失败任务的三次尝试时间线（设计 §12；attempt 1-based 升序）。 */
export function listSourceBodyCaptureAttempts(database: DatabaseSync, jobId: string): SourceBodyCaptureAttempt[] {
  const rows = database.prepare(`SELECT attempt_number AS attempt, started_at AS startedAt, finished_at AS finishedAt,
    error_code AS errorCode, error_message AS errorMessage, http_status AS httpStatus, fetch_method AS fetchMethod,
    content_type AS contentType, extracted_chars AS extractedChars, final_url AS finalUrl, redirect_chain AS redirectChain
    FROM source_body_capture_attempts WHERE job_id = ? ORDER BY attempt_number`).all(jobId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    attempt: Number(row.attempt),
    startedAt: String(row.startedAt ?? ''),
    finishedAt: (row.finishedAt as string | null) ?? null,
    errorCode: (row.errorCode as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    httpStatus: row.httpStatus == null ? null : Number(row.httpStatus),
    fetchMethod: (row.fetchMethod as SourceBodyFetchMethod | null) ?? null,
    contentType: (row.contentType as string | null) ?? null,
    extractedChars: row.extractedChars == null ? null : Number(row.extractedChars),
    finalUrl: (row.finalUrl as string | null) ?? null,
    redirectChain: parseRedirectChain(row.redirectChain)
  }));
}

function parseRedirectChain(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

// ============================================================
// 重试（设计 §9/§12：人工重试新周期；仍最多 3 次；限速约束保留）
// ============================================================

/**
 * 统一重试（调用方事务内；UI 经 dispatcher 授权调用）：
 * - selected：对给定 jobIds 中处于终态失败的项重试（显式人工选择，允许任意终态项）。
 * - reason：对指定 reasonCategory 中 retryable 的终态失败项重试（非可重试项计入 excluded）。
 * - all：对全部 retryable 的终态失败项重试（安全拦截/明确失效/登录验证码/政策禁止自动排除）。
 * 重试 = 新周期：attempt_count 归零、回 pending、next_attempt_at=now；attempts 历史保留。
 */
export function retrySourceBodyCaptureFailures(
  database: DatabaseSync,
  input: SourceBodyCaptureRetryInput
): SourceBodyCaptureRetryResult {
  const workspaceId = workspaceIdOf(database);
  const statuses = TERMINAL_FAILURE_STATUSES.map(() => '?').join(', ');
  const now = new Date().toISOString();
  const candidates: Array<{ jobId: string; retryable: boolean }> = [];
  const excludedJobIds: string[] = [];

  if (input.scope === 'selected') {
    const jobIds = [...new Set((input.jobIds ?? []).filter((id) => typeof id === 'string' && id.trim()))];
    if (jobIds.length === 0) return { retried: 0, excluded: 0, excludedJobIds: [] };
    for (const jobId of jobIds) {
      const row = database.prepare(`${JOB_SELECT} WHERE id = ? AND workspace_id = ?`).get(jobId, workspaceId) as Record<string, unknown> | undefined;
      if (!row) { excludedJobIds.push(jobId); continue; }
      const job = mapJobRow(row);
      if (!TERMINAL_FAILURE_STATUSES.includes(job.status)) { excludedJobIds.push(jobId); continue; }
      candidates.push({ jobId, retryable: job.retryable });
    }
  } else if (input.scope === 'reason') {
    const category = input.reasonCategory ?? null;
    if (!category) return { retried: 0, excluded: 0, excludedJobIds: [] };
    const rows = database.prepare(`${JOB_SELECT} WHERE workspace_id = ? AND reason_category = ? AND status IN (${statuses})`)
      .all(workspaceId, category, ...TERMINAL_FAILURE_STATUSES) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const job = mapJobRow(row);
      candidates.push({ jobId: job.id, retryable: job.retryable });
    }
  } else {
    const rows = database.prepare(`${JOB_SELECT} WHERE workspace_id = ? AND status IN (${statuses})`)
      .all(workspaceId, ...TERMINAL_FAILURE_STATUSES) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const job = mapJobRow(row);
      candidates.push({ jobId: job.id, retryable: job.retryable });
    }
  }

  const retryableIds = candidates.filter((candidate) => {
    // selected = 显式人工选择（设计 §12「重试所选资料」）：允许重试任意终态失败项；
    // reason/all 批量重试才排除安全拦截/明确失效/登录验证码/政策禁止（retryable=false）。
    if (input.scope === 'selected' || candidate.retryable) return true;
    excludedJobIds.push(candidate.jobId);
    return false;
  }).map((candidate) => candidate.jobId);

  for (const jobId of retryableIds) {
    database.prepare(`UPDATE source_body_capture_jobs SET
      status = 'pending', attempt_count = 0, next_attempt_at = ?, started_at = NULL, finished_at = NULL,
      last_error_code = NULL, last_error_message = NULL, last_http_status = NULL, reason_category = NULL,
      retryable = 1, fetch_method = 'static_http', updated_at = ?
      WHERE id = ? AND status IN (${statuses})`)
      .run(now, now, jobId, ...TERMINAL_FAILURE_STATUSES);
  }

  return { retried: retryableIds.length, excluded: excludedJobIds.length, excludedJobIds };
}

// ============================================================
// 批量执行（生产模式：claim/finish 经 dispatcher 授权）
// ============================================================

export type RunDueSourceBodyJobsResult = {
  processed: number;
  ready: number;
  failed: number;
  unavailable: number;
  stale: number;
  backfillClaimed: number;
};

function listDueSourceBodyJobs(database: DatabaseSync, input: { now?: string; limit?: number }): SourceBodyCaptureJobRow[] {
  const now = input.now ?? new Date().toISOString();
  const limit = Math.min(Math.max(input.limit ?? SOURCE_BODY_ARCHIVE_CONCURRENCY, 1), 50);
  const rows = database.prepare(`${JOB_SELECT}
    WHERE status IN ('pending', 'retry_wait') AND next_attempt_at <= ?
    ORDER BY CASE priority WHEN 'new_source' THEN 0 ELSE 1 END, next_attempt_at, id
    LIMIT ?`).all(now, limit) as Array<Record<string, unknown>>;
  return rows.map(mapJobRow);
}

async function runOneJobProduction(
  runtime: ActiveWorkspaceRuntime,
  job: SourceBodyCaptureJobRow,
  deps: SourceBodyArchiveWorkerDeps
): Promise<{ outcome: BodyCaptureOutcome; claimed: boolean }> {
  const now = new Date().toISOString();
  const claimReceipt = await dispatchBusinessCommand(runtime, {
    command: SOURCE_BODY_ARCHIVE_CLAIM_COMMAND,
    requestId: `source-body-archive:${job.id}:claim:${job.attemptCount}`,
    actor: schedulerActor,
    input: { jobId: job.id, expectedAttempts: job.attemptCount, now },
    boundIdentity: runtime.identity,
    entityType: 'source_body_capture_job',
    execute: (db, normalizedInput) => {
      const result = claimSourceBodyJob(db, normalizedInput.jobId, normalizedInput.expectedAttempts, { now: normalizedInput.now });
      return { data: result, entityId: job.id };
    }
  });
  const claimData = requireReceiptData(claimReceipt);
  if (!claimData.claimed) return { outcome: { outcome: 'failed', code: 'STALE', message: '任务状态已变化，跳过本次执行。', retryable: true, fetchMethod: 'static_http', httpStatus: null, retryAfterSeconds: null }, claimed: false };

  // 抓取（事务外）。
  const execution = await executeSourceBodyCapture(runtime.database, claimData.job, deps);

  const finishReceipt = await dispatchBusinessCommand(runtime, {
    command: SOURCE_BODY_ARCHIVE_FINISH_COMMAND,
    requestId: `source-body-archive:${job.id}:finish:${claimData.job.attemptCount}`,
    actor: schedulerActor,
    input: { jobId: job.id, expectedAttempts: claimData.job.attemptCount, outcome: execution, now },
    boundIdentity: runtime.identity,
    entityType: 'source_body_capture_job',
    execute: (db, normalizedInput) => {
      const result = finishSourceBodyJob(db, {
        jobId: normalizedInput.jobId,
        expectedAttempts: normalizedInput.expectedAttempts,
        outcome: normalizedInput.outcome,
        now: normalizedInput.now
      });
      return { data: result, entityId: job.id };
    }
  });
  const finishData = requireReceiptData(finishReceipt);
  if (finishData.jobStatus === 'ready') {
    broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.body_archive' });
    // 设计 §15：正文版本落地后经现有受控增量机制触发该 Source 的重新评估。
    scheduleSourceKnowledgeCompile({ sourceId: job.sourceId, revision: job.sourceRevision });
  } else if (finishData.jobStatus === 'needs_review' || finishData.jobStatus === 'unavailable') {
    broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.body_archive.failed' });
  }
  return { outcome: execution, claimed: true };
}

/**
 * 处理到期正文任务（并发 = SOURCE_BODY_ARCHIVE_CONCURRENCY；new_source 优先；
 * historical_backfill 至多 1 个 claim/分钟）。仅生产模式（ActiveWorkspaceRuntime）。
 */
export async function runDueSourceBodyJobs(
  runtime: ActiveWorkspaceRuntime,
  input: { isCurrent?: () => boolean; deps?: SourceBodyArchiveWorkerDeps; lastBackfillClaimAt?: { current: number } } = {}
): Promise<RunDueSourceBodyJobsResult> {
  const database = runtime.database;
  const deps = input.deps ?? {};
  const backfillGate = input.lastBackfillClaimAt ?? { current: 0 };
  input.lastBackfillClaimAt = backfillGate;
  const result: RunDueSourceBodyJobsResult = { processed: 0, ready: 0, failed: 0, unavailable: 0, stale: 0, backfillClaimed: 0 };
  if (isSourceBodyArchivePaused(database)) return result;
  const nowMs = Date.now();
  const due = listDueSourceBodyJobs(database, { now: new Date(nowMs).toISOString(), limit: SOURCE_BODY_ARCHIVE_CONCURRENCY });
  for (const job of due) {
    if (input.isCurrent && !input.isCurrent()) break;
    if (isSourceBodyArchivePaused(database)) break;
    // 历史补抓限速（设计 §13：至多 1 个 claim/分钟）。
    if (job.priority === 'historical_backfill') {
      if (nowMs - backfillGate.current < SOURCE_BODY_BACKFILL_CLAIM_INTERVAL_MS) continue;
      backfillGate.current = nowMs;
      result.backfillClaimed += 1;
    }
    result.processed += 1;
    const run = await runOneJobProduction(runtime, job, deps);
    if (!run.claimed) { result.stale += 1; continue; }
    const outcome = run.outcome.outcome;
    if (outcome === 'ready') result.ready += 1;
    else if (outcome === 'unavailable') result.unavailable += 1;
    else result.failed += 1;
  }
  return result;
}

// ============================================================
// 调度器（与 MediaArchiveScheduler 同构：到期轮询 + 完成唤醒）
// ============================================================

const DEFAULT_SCHEDULER_INTERVAL_MS = 5_000;

/**
 * 正文归档调度器：
 * - 首 tick 启动恢复（孤儿 running → EXECUTION_INTERRUPTED 回收）+ 历史补抓单页；
 * - 每 tick 处理到期 jobs（并发 = SOURCE_BODY_ARCHIVE_CONCURRENCY；全局暂停时停止 claim）；
 * - new_source 优先；historical_backfill 至多 1 个 claim/分钟。
 */
export class SourceBodyArchiveScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private rerun = false;
  private generation = 0;
  private recovered = false;
  private backfillDone = false;
  private lastBackfillClaimAt = { current: 0 };
  private readonly options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number; deps?: SourceBodyArchiveWorkerDeps };

  constructor(options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number; deps?: SourceBodyArchiveWorkerDeps }) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.recovered = false;
    this.backfillDone = false;
    this.lastBackfillClaimAt = { current: 0 };
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.current) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.rerun = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    await this.current?.catch(() => {});
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.current) return;
    this.timer = null;
    const generation = this.generation;
    const runtime = this.options.runtime;
    const intervalMs = this.options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
    this.current = (async () => {
      if (this.stopped || generation !== this.generation || !runtime.isActive || (this.options.isCurrent && !this.options.isCurrent())) return;
      try {
        if (!this.recovered) {
          const recovery = await dispatchBusinessCommand(runtime, {
            command: 'source_body_archive.recover',
            requestId: `source-body-archive:recover:${generation}`,
            actor: schedulerActor,
            input: {},
            boundIdentity: runtime.identity,
            entityType: 'source_body_capture_job',
            execute: (db) => ({ data: recoverInterruptedSourceBodyJobs(db, {}) })
          });
          const recovered = requireReceiptData(recovery);
          if (recovered.recovered > 0 || recovered.exhausted > 0) {
            broadcastDataChanged({ scopes: ['sources', 'library', 'today'], reason: 'source.body_archive.recover' });
          }
          this.recovered = true;
        }
        // 历史补抓：每 tick 至多 1 页（分页登记，不阻塞当天扫描；水位持久化）。
        if (!this.backfillDone) {
          const page = await dispatchBusinessCommand(runtime, {
            command: 'source_body_archive.backfill_page',
            requestId: `source-body-archive:backfill:${generation}:${randomUUID()}`,
            actor: schedulerActor,
            input: {},
            boundIdentity: runtime.identity,
            entityType: 'source_body_capture_job',
            execute: (db) => ({ data: runSourceBodyBackfillPage(db, {}) })
          });
          const backfill = requireReceiptData(page);
          this.backfillDone = backfill.done;
        }
        const drained = await runDueSourceBodyJobs(runtime, {
          isCurrent: () => !this.stopped && generation === this.generation && runtime.isActive && (!this.options.isCurrent || this.options.isCurrent()),
          deps: this.options.deps,
          lastBackfillClaimAt: this.lastBackfillClaimAt
        });
        if (drained.processed > 0 && !this.stopped && generation === this.generation) {
          this.wake();
        }
      } catch (error) {
        console.error('[source-body-archive] scheduler tick failed', error);
      }
    })();
    await this.current;
    this.current = null;
    if (this.stopped || (this.options.isCurrent && !this.options.isCurrent())) return;
    if (this.rerun) {
      this.rerun = false;
      this.wake();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
}
