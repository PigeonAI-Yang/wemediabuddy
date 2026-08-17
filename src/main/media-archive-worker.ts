/**
 * WMB-5244：媒体归档 Worker（渠道媒体冻结的执行侧）。
 * Design: docs/spark/2026-08-14-wmb-intelligence-media-production-pipeline-design.md §6.4/§7/§8。
 *
 * 职责：认领 media_archive / media_discover job（乐观 claim，attempts+1，全局并发 3）→
 * fetchWithMediaGuard 安全下载（SSRF/HEAD/流式限额/magic/时长/SHA）→ 同事务完成
 * （Asset + Binding + Provenance + 候选终态 + Attempt + Job）；启动恢复（孤儿 running
 * 超 15 分钟 → DOWNLOAD_INTERRUPTED 并按 attempt 上限重试）；全局暂停（只停 claim）；
 * 命令面（归档重试 / 全局暂停）；Source 详情读模型。
 *
 * 持久层原语全部复用 MediaSchema 的 src/main/db/media-archive-store.ts（不建第二套）；
 * 本模块只持有 job 生命周期 SQL（claim/finish/recovery）与运行时常量。
 *
 * 不变量：
 * - preserved 的唯一入口是 completeMediaCandidatePreserved（同事务写 Binding）；失败候选
 *   绝不创建假 Asset/Binding。
 * - 同字节跨 Source 复用 Asset（registerStagedAsset sha256 去重），各 Source 保留独立 Binding/Provenance。
 * - 自动重试只处理 retryable failed（指数退避）；unsupported/needs_user/skipped_limit 不自动重试。
 * - 视频先落位再时长探测；超 30 分钟 → needs_user，清理落位文件，不登记 Asset。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { MEDIA_ARCHIVE_JOB_KIND, MEDIA_DISCOVER_JOB_KIND, MEDIA_DEFAULT_MAX_ATTEMPTS, mediaArchiveDedupeKey, mediaDiscoverDedupeKey, type MediaCandidateKind, type MediaChannel } from '../shared/media-candidates.ts';
import { MEDIA_LIMITS_DEFAULT, type MediaLimits } from '../shared/media-limits.ts';
import {
  getMediaCandidate,
  getArchiveAttempt,
  insertMediaCandidates,
  listArchiveAttempts,
  listMediaCandidatesForRevision,
  listSourceMediaBindings,
  mediaArchiveStatusSummary,
  transitionMediaCandidate,
  writeArchiveAttempt,
  completeMediaCandidatePreserved,
  stableRemoteIdentity,
  type MediaArchiveAttemptRecord,
  type MediaCandidateInput,
  type MediaCandidateRecord,
  type MediaDiscoverJobPayload,
  type SourceMediaBindingRecord
} from './db/media-archive-store.ts';
import { registerStagedAsset, type StagedAsset } from './assets.ts';
import { fetchWithMediaGuard, type FetchWithMediaGuardInput, type MediaDurationProbeResult, type StagedDownload } from './media-archive-fetch.ts';
import { dispatchBusinessCommand, requireReceiptData } from './business-command.ts';
import type { CommandActorV1 } from './command-dispatcher.ts';
import type { ActiveWorkspaceRuntime } from './workspace-runtime.ts';
import { broadcastDataChanged } from './data-changed.ts';

// ============================================================
// 运行时常量（设计 §8 首版默认值；限额单一真源 = shared/media-limits.ts）
// ============================================================

/** 全局下载并发（设计 §8：3）。 */
export const MEDIA_ARCHIVE_CONCURRENCY = MEDIA_LIMITS_DEFAULT.downloadConcurrency;

/** Worker 运行调优（不进 shared 限额契约：退避窗口与孤儿判定）。 */
export const MEDIA_WORKER_TUNING = Object.freeze({
  /** 失败重试指数退避基数（30s）。 */
  retryBackoffBaseMs: 30_000,
  /** 失败重试退避上限（1h）。 */
  retryBackoffMaxMs: 3_600_000,
  /** 孤儿 downloading/running 判定窗口（15 分钟）。 */
  interruptedStaleMs: 15 * 60 * 1000
} as const);

/** 指数退避：attempt 为已完成执行序号（1-based）。 */
export function mediaRetryBackoffMs(attempt: number, tuning: Readonly<typeof MEDIA_WORKER_TUNING> = MEDIA_WORKER_TUNING): number {
  const delay = tuning.retryBackoffBaseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, tuning.retryBackoffMaxMs);
}

/** 命令名（Capability/Dispatcher 注册）。 */
export const MEDIA_ARCHIVE_RETRY_COMMAND = 'media_archive.retry_candidate' as const;
export const MEDIA_ARCHIVE_SET_PAUSED_COMMAND = 'media_archive.set_paused' as const;
export const MEDIA_ARCHIVE_CLAIM_COMMAND = 'media_archive.claim_job' as const;
export const MEDIA_ARCHIVE_FINISH_COMMAND = 'media_archive.finish_job' as const;
export const MEDIA_ARCHIVE_RECOVER_COMMAND = 'media_archive.recover' as const;

export const MEDIA_ARCHIVE_CHANNEL_X = 'x_lists' as const;
export const MEDIA_ARCHIVE_CHANNEL_WEB = 'official_web' as const;
export const MEDIA_ARCHIVE_CHANNEL_RESEARCH = 'research' as const;

const schedulerActor = Object.freeze({ type: 'scheduler', id: 'media-archive', label: 'media-archive' }) as { type: 'scheduler'; id: string; label: string };

// ============================================================
// Worker 注入缝（测试经此伪造 HTTP/DNS/时长，无需网络）
// ============================================================

export type MediaArchiveWorkerDeps = Readonly<{
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  probeDurationMs?: (filePath: string, mimeType: string) => Promise<MediaDurationProbeResult>;
}>;

/** preserved 图片提交后钩子（ImageUnderstanding 注册；late-bound，避免循环依赖）。 */
export type MediaArchivePostPreserveHook = (database: DatabaseSync, input: Readonly<{
  sourceId: string;
  sourceRevisionKey: string;
  assetId: string;
  kind: MediaCandidateKind;
}>) => void;

let postPreserveHook: MediaArchivePostPreserveHook | null = null;

/** 注册 preserved 提交后钩子（只在提交后调用，不进入归档事务）。 */
export function setMediaArchivePostPreserveHook(hook: MediaArchivePostPreserveHook | null): void {
  postPreserveHook = hook;
}

function callPostPreserveHook(database: DatabaseSync, input: Parameters<MediaArchivePostPreserveHook>[1]): void {
  if (postPreserveHook) postPreserveHook(database, input);
}

// ============================================================
// 全局暂停（M1 只提供全局：停止 claim 新 job）
// ============================================================

const PAUSE_META_KEY = 'media_archive_paused';

export function isMediaArchivePaused(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT value FROM app_meta WHERE key = ?").get(PAUSE_META_KEY) as { value?: string } | undefined;
  return row?.value === '1';
}

export function setMediaArchivePaused(database: DatabaseSync, paused: boolean): void {
  const now = new Date().toISOString();
  const existing = database.prepare('SELECT revision FROM app_meta WHERE key = ?').get(PAUSE_META_KEY) as { revision?: number } | undefined;
  if (existing) {
    database.prepare('UPDATE app_meta SET value = ?, updated_at = ?, revision = revision + 1 WHERE key = ?')
      .run(paused ? '1' : '0', now, PAUSE_META_KEY);
  } else {
    database.prepare('INSERT INTO app_meta (key, value, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)')
      .run(PAUSE_META_KEY, paused ? '1' : '0', now, now);
  }
}

// ============================================================
// Job 行（复用现有 jobs 表；kind 无 CHECK，media_archive/media_discover 天然兼容）
// ============================================================

export type MediaArchiveJobRow = Readonly<{
  id: string;
  kind: string;
  status: string;
  dueAt: string;
  attempts: number;
  dedupeKey: string;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}>;

const JOB_SELECT = `id, kind, status, due_at AS dueAt, attempts, dedupe_key AS dedupeKey, payload_json AS payloadJson,
  last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt, finished_at AS finishedAt`;

function mapJobRow(row: Record<string, unknown>): MediaArchiveJobRow {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    dueAt: String(row.dueAt),
    attempts: Number(row.attempts),
    dedupeKey: String(row.dedupeKey),
    payload: JSON.parse(String(row.payloadJson)) as Record<string, unknown>,
    lastError: (row.lastError as string | null) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    startedAt: (row.startedAt as string | null) ?? null,
    finishedAt: (row.finishedAt as string | null) ?? null
  };
}

function getJobRow(database: DatabaseSync, jobId: string): MediaArchiveJobRow | null {
  const row = database.prepare(`SELECT ${JOB_SELECT} FROM jobs WHERE id = ?`).get(jobId);
  return row ? mapJobRow(row as Record<string, unknown>) : null;
}

function findJobByDedupe(database: DatabaseSync, dedupeKey: string): MediaArchiveJobRow | null {
  const row = database.prepare(`SELECT ${JOB_SELECT} FROM jobs WHERE dedupe_key = ?`).get(dedupeKey);
  return row ? mapJobRow(row as Record<string, unknown>) : null;
}

/** 到期的 media_archive/media_discover jobs（稳定序：due_at, id）。 */
export function listDueMediaJobs(database: DatabaseSync, input: { now?: string; limit?: number } = {}): MediaArchiveJobRow[] {
  const now = input.now ?? new Date().toISOString();
  const limit = Math.min(Math.max(input.limit ?? MEDIA_ARCHIVE_CONCURRENCY, 1), 50);
  const rows = database.prepare(`SELECT ${JOB_SELECT} FROM jobs
    WHERE kind IN (?, ?) AND status = 'pending' AND due_at <= ?
    ORDER BY due_at, id LIMIT ?`)
    .all(MEDIA_ARCHIVE_JOB_KIND, MEDIA_DISCOVER_JOB_KIND, now, limit) as Array<Record<string, unknown>>;
  return rows.map(mapJobRow);
}

// ============================================================
// 乐观 claim（attempts+1；候选 downloading；attempt 行按执行序号推进）
// ============================================================

export type ClaimResult =
  | { claimed: true; job: MediaArchiveJobRow; attemptNumber: number; candidate: MediaCandidateRecord | null }
  | { claimed: false; reason: 'STALE' | 'PAUSED' | 'CANDIDATE_NOT_FOUND' };

/**
 * 认领一个到期 job（调用方事务内执行）：
 * - jobs 乐观锁：status='pending' AND attempts=expected AND due_at<=now；
 * - media_archive：候选 pending/failed → downloading；attempt 行按执行序号 upsert
 *   （执行序号已被已结束行占用时顺延 MAX(attempt)+1，用户重试后不会 UNIQUE 冲突）；
 * - media_discover：无候选，仅 job 转 running。
 * 全局暂停时跳过 claim（job 保持 pending）。
 */
export function claimMediaArchiveJob(
  database: DatabaseSync,
  jobId: string,
  expectedAttempts: number,
  input: { now?: string; requestId?: string } = {}
): ClaimResult {
  if (isMediaArchivePaused(database)) return { claimed: false, reason: 'PAUSED' };
  const now = input.now ?? new Date().toISOString();
  const claimed = database.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND attempts = ? AND due_at <= ?`)
    .run(now, now, jobId, expectedAttempts, now);
  if (Number(claimed.changes ?? 0) !== 1) return { claimed: false, reason: 'STALE' };
  const job = getJobRow(database, jobId)!;
  if (job.kind !== MEDIA_ARCHIVE_JOB_KIND) {
    return { claimed: true, job, attemptNumber: job.attempts, candidate: null };
  }
  const candidateId = String(job.payload.candidateId ?? '');
  const candidate = getMediaCandidate(database, candidateId);
  if (!candidate) {
    // 候选已不存在：job 直接终态 failed（CANDIDATE_NOT_FOUND），不重试。
    database.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run('CANDIDATE_NOT_FOUND', now, now, jobId);
    return { claimed: false, reason: 'CANDIDATE_NOT_FOUND' };
  }
  transitionMediaCandidate(database, {
    candidateId,
    to: 'downloading',
    errorCode: null,
    errorMessage: null,
    retryAfter: null
  });
  // 执行序号 = job.attempts（已 +1）；若该序号已被已结束 attempt 行占用（用户重试）→ 顺延 MAX+1。
  let attemptNumber = job.attempts;
  const existing = getArchiveAttempt(database, candidateId, attemptNumber);
  if (existing && existing.finishedAt !== null) {
    const rows = database.prepare('SELECT MAX(attempt) AS maxAttempt FROM media_archive_attempts WHERE candidate_id = ?')
      .get(candidateId) as { maxAttempt: number | null };
    attemptNumber = Number(rows.maxAttempt ?? 0) + 1;
  }
  writeArchiveAttempt(database, {
    candidateId,
    attempt: attemptNumber,
    status: 'running',
    startedAt: now,
    runtimeName: null,
    runtimeVersion: null,
    parameterHash: null
  });
  return { claimed: true, job, attemptNumber, candidate: getMediaCandidate(database, candidateId) };
}

// ============================================================
// 执行（下载在事务外；结果交给 finish 事务原子落库）
// ============================================================

export type ArchiveExecutionOutcome =
  | { outcome: 'preserved'; staged: StagedDownload; attemptNumber: number }
  | { outcome: 'failed' | 'needs_user' | 'unsupported'; code: string; message: string; retryable: boolean; attemptNumber: number }
  | { outcome: 'skipped_limit'; code: string; message: string; attemptNumber: number; staged: StagedDownload };

export type DiscoverExecutionOutcome =
  | { outcome: 'discovered'; candidates: MediaCandidateInput[]; channel: MediaChannel; attemptNumber: number; htmlPath: string }
  | { outcome: 'failed' | 'needs_user' | 'unsupported'; code: string; message: string; retryable: boolean; attemptNumber: number };

function modeForKind(kind: MediaCandidateKind): 'image' | 'video' {
  return kind === 'video' ? 'video' : 'image';
}

function parameterHashFor(staged: StagedDownload, candidate: MediaCandidateRecord): string {
  const limits = MEDIA_LIMITS_DEFAULT;
  return createHash('sha256').update(JSON.stringify({
    mode: modeForKind(candidate.kind),
    mimeType: staged.mimeType,
    imageMaxBytes: limits.imageMaxBytes,
    videoMaxBytes: limits.videoMaxBytes,
    videoMaxDurationMs: limits.videoMaxDurationMs,
    maxRedirects: limits.maxRedirects,
    connectTimeoutMs: limits.connectTimeoutMs
  })).digest('hex');
}

/** 候选的下载 URL 链：original_url 优先，alternate_urls_json 依次回退（§7.2 orig→medium→thumb）。 */
export function downloadUrlChain(candidate: Pick<MediaCandidateRecord, 'originalUrl'> & { alternateUrls?: readonly string[] }): string[] {
  const chain = [candidate.originalUrl];
  for (const url of candidate.alternateUrls ?? []) {
    if (typeof url === 'string' && url.trim() && url !== candidate.originalUrl) chain.push(url);
  }
  return chain;
}

/**
 * 执行一次归档（事务外下载）：逐 URL 回退（仅 failed 回退；SSRF_BLOCKED 立即终止；
 * needs_user/unsupported 不再回退）。成功返回 preserved + staged。
 * attemptNumber 必须来自 claim 结果（用户重试后可能 ≠ candidate.attemptCount+1）。
 */
export async function executeMediaArchiveCandidate(
  database: DatabaseSync,
  candidateId: string,
  attemptNumber: number,
  dataRoot: string,
  deps: MediaArchiveWorkerDeps = {},
  signal?: AbortSignal
): Promise<ArchiveExecutionOutcome> {
  const candidate = getMediaCandidate(database, candidateId);
  if (!candidate) {
    return { outcome: 'failed', code: 'CANDIDATE_NOT_FOUND', message: `候选 ${candidateId} 不存在。`, retryable: false, attemptNumber };
  }
  const chains = downloadUrlChain(candidate);
  let lastError: { code: string; message: string; retryable: boolean } | null = null;
  for (const url of chains) {
    const fetchInput: FetchWithMediaGuardInput = {
      url,
      mode: modeForKind(candidate.kind),
      limits: MEDIA_LIMITS_DEFAULT,
      dataRoot,
      fetchImpl: deps.fetchImpl,
      resolveHost: deps.resolveHost,
      probeDurationMs: deps.probeDurationMs,
      signal,
      downloadLabel: `${candidate.id}.a${attemptNumber}`
    };
    const result = await fetchWithMediaGuard(fetchInput);
    if (result.ok) {
      return { outcome: 'preserved', staged: result.staged, attemptNumber };
    }
    lastError = { code: result.error.code, message: result.error.message, retryable: result.error.retryable };
    if (result.error.candidateStatus !== 'failed' || result.error.code === 'SSRF_BLOCKED') {
      // 确定性落态（needs_user/unsupported）或安全拒绝：不回退更多 URL。
      return { outcome: result.error.candidateStatus, code: result.error.code, message: result.error.message, retryable: result.error.retryable, attemptNumber };
    }
  }
  return {
    outcome: 'failed',
    code: lastError?.code ?? 'FETCH_FAILED',
    message: lastError?.message ?? '下载失败。',
    retryable: lastError?.retryable ?? true,
    attemptNumber
  };
}

/** 执行一次发现（事务外抓 HTML + 解析候选；候选落库在 finish 事务）。 */
export async function executeMediaDiscover(
  database: DatabaseSync,
  job: MediaArchiveJobRow,
  dataRoot: string,
  deps: MediaArchiveWorkerDeps = {},
  signal?: AbortSignal
): Promise<DiscoverExecutionOutcome> {
  const payload = job.payload as MediaDiscoverJobPayload;
  const result = await fetchWithMediaGuard({
    url: payload.originalUrl,
    mode: 'html',
    limits: MEDIA_LIMITS_DEFAULT,
    dataRoot,
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
    signal,
    downloadLabel: `discover.${job.id}`
  });
  if (!result.ok) {
    return {
      outcome: result.error.candidateStatus,
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
      attemptNumber: job.attempts
    };
  }
  const html = await readFile(result.staged.filePath, 'utf8');
  const candidates = extractHtmlMediaCandidates(html, payload.originalUrl, MEDIA_LIMITS_DEFAULT);
  return {
    outcome: 'discovered',
    candidates,
    channel: deriveDiscoveryChannel(database, payload.sourceId),
    attemptNumber: job.attempts,
    htmlPath: result.staged.filePath
  };
}

// ============================================================
// 网页媒体有界发现（设计 §7.3 规则；只服务候选发现，不升级为第二内容真源）
// ============================================================

const OG_IMAGE_RE = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi;
const OG_VIDEO_RE = /<meta[^>]+(?:property|name)=["'](?:og:video(?::url)?)["'][^>]*>/gi;
const IMG_RE = /<img\b[^>]*>/gi;
const VIDEO_RE = /<video\b[^>]*>/gi;
const SOURCE_RE = /<source\b[^>]*>/gi;

function attrValue(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  if (match) return match[2]?.trim() ?? null;
  const bare = tag.match(new RegExp(`${name}\\s*=\\s*([^\\s"'<>]+)`, 'i'));
  return bare ? (bare[1]?.trim() ?? null) : null;
}

function declaredDimension(tag: string, name: 'width' | 'height'): number | null {
  const raw = attrValue(tag, name);
  if (raw === null) return null;
  const value = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** srcset 取第一个候选 URL（有界发现；不解析复杂断点）。 */
function firstSrcsetUrl(srcset: string): string | null {
  const first = srcset.split(',')[0]?.trim();
  if (!first) return null;
  const url = first.split(/\s+/)[0];
  return url || null;
}

function resolveUrl(raw: string, baseUrl: string): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const scheme = trimmed.split(':', 1)[0]?.toLowerCase() ?? '';
  if (scheme === 'data' || scheme === 'blob' || scheme === 'file' || scheme === 'javascript') return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * 从净化后的 HTML 提取有界媒体候选（DOM 顺序；排除 data/blob、favicon、声明宽或高
 * <64px、tracking pixel（由 <64px 覆盖）；OG 图只在正文没有同 URL 时补入（身份去重））。
 * 计数上限：最多 maxImagesPerRevision 图 + maxVideosPerRevision 视频；video_poster 与父视频同 ordinal。
 */
export function extractHtmlMediaCandidates(html: string, baseUrl: string, limits: MediaLimits): MediaCandidateInput[] {
  interface Slot { index: number; kind: MediaCandidateKind; url: string; parentVideoUrl?: string }
  const slots: Slot[] = [];
  const seen = new Set<string>();
  const push = (index: number, kind: MediaCandidateKind, rawUrl: string, parentVideoUrl?: string): void => {
    const url = resolveUrl(rawUrl, baseUrl);
    if (!url) return;
    const identity = stableRemoteIdentity(url);
    if (seen.has(identity)) return;
    seen.add(identity);
    slots.push({ index, kind, url, parentVideoUrl });
  };

  for (const match of html.matchAll(OG_IMAGE_RE)) {
    const content = attrValue(match[0], 'content');
    if (content) push(match.index, 'image', content);
  }
  for (const match of html.matchAll(OG_VIDEO_RE)) {
    const content = attrValue(match[0], 'content');
    if (content) push(match.index, 'video', content);
  }
  for (const match of html.matchAll(IMG_RE)) {
    const tag = match[0];
    const width = declaredDimension(tag, 'width');
    const height = declaredDimension(tag, 'height');
    if (width !== null && width < limits.minMediaDimensionPx) continue;
    if (height !== null && height < limits.minMediaDimensionPx) continue;
    const srcset = attrValue(tag, 'srcset');
    const src = srcset ? firstSrcsetUrl(srcset) : attrValue(tag, 'src');
    if (src) push(match.index, 'image', src);
  }
  for (const match of html.matchAll(VIDEO_RE)) {
    const tag = match[0];
    const src = attrValue(tag, 'src');
    const poster = attrValue(tag, 'poster');
    if (src) push(match.index, 'video', src);
    if (poster) push(match.index, 'video_poster', poster, src ?? undefined);
  }
  for (const match of html.matchAll(SOURCE_RE)) {
    const tag = match[0];
    const type = attrValue(tag, 'type') ?? '';
    const src = attrValue(tag, 'src');
    const srcset = attrValue(tag, 'srcset');
    if (!src && !srcset) continue;
    if (/^video\//i.test(type) || /mpegurl|mp4|webm/i.test(type)) {
      if (src) push(match.index, 'video', src);
    } else if (/^image\//i.test(type)) {
      if (srcset) push(match.index, 'image', firstSrcsetUrl(srcset) ?? '');
      else if (src) push(match.index, 'image', src);
    } else if (!type) {
      // 无 type 的 <source>：若 src 含视频扩展名视为视频，否则按图片 srcset 处理。
      if (src && /\.(mp4|webm|m4v)(\?|$)/i.test(src)) push(match.index, 'video', src);
      else if (srcset) push(match.index, 'image', firstSrcsetUrl(srcset) ?? '');
      else if (src) push(match.index, 'image', src);
    }
  }
  slots.sort((left, right) => left.index - right.index);

  // 计数上限（按 DOM 序保留首批）。
  const kept: Slot[] = [];
  let imageCount = 0;
  let videoCount = 0;
  for (const slot of slots) {
    if (slot.kind === 'video') {
      if (videoCount >= limits.maxVideosPerRevision) continue;
      videoCount += 1;
    } else if (slot.kind === 'image') {
      if (imageCount >= limits.maxImagesPerRevision) continue;
      imageCount += 1;
    } else {
      // video_poster：父视频不在保留集内则丢弃。
      if (slot.parentVideoUrl && !kept.some((item) => item.kind === 'video' && item.url === slot.parentVideoUrl)) continue;
    }
    kept.push(slot);
  }
  const videoOrdinal = new Map<string, number>();
  const candidates: MediaCandidateInput[] = [];
  kept.forEach((slot, ordinal) => {
    if (slot.kind === 'video') videoOrdinal.set(slot.url, ordinal);
  });
  for (const slot of kept) {
    const parentOrdinal = slot.kind === 'video_poster' && slot.parentVideoUrl
      ? (videoOrdinal.get(slot.parentVideoUrl) ?? null)
      : null;
    candidates.push({
      kind: slot.kind,
      originalUrl: slot.url,
      channel: 'research', // 由调用方以 deriveDiscoveryChannel 覆盖
      postKind: 'web',
      parentOrdinal,
      ordinalInPost: null,
      ordinal: candidates.length,
      captionHint: null,
      surroundingText: null,
      maxAttempts: limits.maxAttempts
    });
  }
  return candidates;
}

/** 由 Source feed 归属推导发现任务候选的 channel（无 feed → research）。 */
export function deriveDiscoveryChannel(database: DatabaseSync, sourceId: string): MediaChannel {
  const source = database.prepare('SELECT feed_id AS feedId FROM source_items WHERE id = ?').get(sourceId) as { feedId: string | null } | undefined;
  const feedId = source?.feedId;
  if (feedId) {
    const row = database.prepare(`SELECT module FROM (
        SELECT 'official_web' AS module FROM website_sources WHERE source_feed_id = ?
        UNION ALL
        SELECT 'x_lists' AS module FROM x_list_bindings WHERE source_feed_id = ?
      ) LIMIT 1`).get(feedId, feedId) as { module: string } | undefined;
    if (row?.module === 'official_web') return 'official_web';
    if (row?.module === 'x_lists') return 'x_lists';
  }
  return 'research';
}

// ============================================================
// Finish（同事务：Asset + Binding + Provenance + 候选终态 + Attempt + Job）
// ============================================================

export type FinishResult = Readonly<{
  finished: boolean;
  stale: boolean;
  outcome: string;
  candidate: MediaCandidateRecord | null;
  binding: SourceMediaBindingRecord | null;
  jobStatus: string;
  /** skipped_limit 且落位文件未被任何 Source 注册 → 调用方（事务外）删除。 */
  deleteFilePath: string | null;
}>;

const FINISH_TERMINAL_JOB_STATUS: Readonly<Record<string, 'succeeded' | 'failed' | 'needs_user'>> = Object.freeze({
  preserved: 'succeeded',
  failed: 'failed',
  needs_user: 'needs_user',
  unsupported: 'needs_user',
  skipped_limit: 'needs_user',
  discovered: 'succeeded'
});

/**
 * 完成一次归档/发现（调用方事务内，同步）：
 * - preserved：字节总量限额校验 → registerStagedAsset（sha256 去重复用）→
 *   completeMediaCandidatePreserved（Binding + imported Provenance + 候选终态）→
 *   attempt succeeded → job succeeded。同候选重放幂等。
 * - failed（临时）：候选 failed + 退避重排 job（attempts<max）或 job failed（耗尽）。
 * - needs_user/unsupported/skipped_limit：候选终态 + job needs_user（不自动重试）。
 * - discovered：insertMediaCandidates（发现候选 + 初始 Attempt + media_archive jobs）+ job succeeded。
 */
export function finishMediaArchiveJob(
  database: DatabaseSync,
  input: {
    jobId: string;
    expectedAttempts: number;
    result: ArchiveExecutionOutcome | DiscoverExecutionOutcome;
    now?: string;
    createdBy?: string;
  }
): FinishResult {
  const now = input.now ?? new Date().toISOString();
  const job = getJobRow(database, input.jobId);
  if (!job || job.status !== 'running' || job.attempts !== input.expectedAttempts) {
    return { finished: false, stale: true, outcome: 'stale', candidate: null, binding: null, jobStatus: job?.status ?? 'missing', deleteFilePath: null };
  }

  if (job.kind === MEDIA_DISCOVER_JOB_KIND) {
    return finishDiscoverJob(database, job, input.result as DiscoverExecutionOutcome, now);
  }

  const candidate = getMediaCandidate(database, String(job.payload.candidateId ?? ''));
  if (!candidate) {
    database.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run('CANDIDATE_NOT_FOUND', now, now, input.jobId);
    return { finished: true, stale: false, outcome: 'failed', candidate: null, binding: null, jobStatus: 'failed', deleteFilePath: null };
  }
  const result = input.result as ArchiveExecutionOutcome;
  const attemptNumber = result.attemptNumber || candidate.attemptCount + 1;
  const createdBy = input.createdBy ?? 'media-archive-worker';

  if (result.outcome === 'preserved') {
    const preservedResult = preserveCandidate(database, job, candidate, result.staged, attemptNumber, now, createdBy);
    return preservedResult;
  }

  // 失败/确定性终态路径。
  const retryable = result.outcome === 'failed' && result.retryable;
  const attemptsExhausted = job.attempts >= candidate.maxAttempts;
  if (retryable && !attemptsExhausted) {
    const dueAt = new Date(Date.parse(now) + mediaRetryBackoffMs(job.attempts)).toISOString();
    transitionMediaCandidate(database, {
      candidateId: candidate.id,
      to: 'failed',
      errorCode: result.code,
      errorMessage: result.message,
      retryAfter: dueAt
    });
    database.prepare(`UPDATE jobs SET status = 'pending', due_at = ?, last_error = ?, started_at = NULL, updated_at = ? WHERE id = ?`)
      .run(dueAt, `${result.code}: ${result.message}`, now, input.jobId);
    writeArchiveAttempt(database, {
      candidateId: candidate.id,
      attempt: attemptNumber,
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      errorCode: result.code,
      errorMessage: result.message
    });
    return { finished: true, stale: false, outcome: 'failed', candidate: getMediaCandidate(database, candidate.id), binding: null, jobStatus: 'pending', deleteFilePath: null };
  }

  // 终态：failed（耗尽）/ needs_user / unsupported / skipped_limit。
  const candidateStatus = result.outcome === 'skipped_limit' ? 'skipped_limit' : result.outcome;
  const terminalCode = result.outcome === 'failed' ? `${result.code}_RETRY_EXHAUSTED` : result.code;
  transitionMediaCandidate(database, {
    candidateId: candidate.id,
    to: candidateStatus as 'failed' | 'needs_user' | 'unsupported' | 'skipped_limit',
    errorCode: terminalCode,
    errorMessage: result.message,
    retryAfter: null
  });
  const attemptStatus = result.outcome === 'skipped_limit'
    ? 'failed' as const
    : result.outcome === 'needs_user'
      ? 'needs_user' as const
      : result.outcome === 'unsupported'
        ? 'unsupported' as const
        : 'failed' as const;
  writeArchiveAttempt(database, {
    candidateId: candidate.id,
    attempt: attemptNumber,
    status: attemptStatus,
    startedAt: now,
    finishedAt: now,
    errorCode: terminalCode,
    errorMessage: result.message
  });
  const jobStatus = FINISH_TERMINAL_JOB_STATUS[candidateStatus] ?? 'failed';
  database.prepare(`UPDATE jobs SET status = ?, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(jobStatus, `${terminalCode}: ${result.message}`, now, now, input.jobId);

  let deleteFilePath: string | null = null;
  if (result.outcome === 'skipped_limit' && 'staged' in result) {
    // 字节超限：落位文件若未被任何 Source 注册（sha256 无 assets 行）→ 调用方删除；否则保留复用。
    const registered = database.prepare('SELECT id FROM assets WHERE sha256 = ?').get(result.staged.sha256);
    if (!registered) deleteFilePath = result.staged.filePath;
  }
  return {
    finished: true,
    stale: false,
    outcome: candidateStatus,
    candidate: getMediaCandidate(database, candidate.id),
    binding: null,
    jobStatus,
    deleteFilePath
  };
}

function preserveCandidate(
  database: DatabaseSync,
  job: MediaArchiveJobRow,
  candidate: MediaCandidateRecord,
  staged: StagedDownload,
  attemptNumber: number,
  now: string,
  createdBy: string
): FinishResult {
  const limits = MEDIA_LIMITS_DEFAULT;
  // 每 Source revision 字节总量上限（设计 §8：1GiB）→ skipped_limit。
  const preservedRow = database.prepare(`SELECT COALESCE(SUM(a.byte_count), 0) AS bytes
    FROM source_media_bindings b JOIN assets a ON a.id = b.asset_id
    WHERE b.source_revision_key = ? AND b.archived_at IS NULL`).get(String(job.payload.sourceRevisionKey ?? '')) as { bytes: number };
  if (Number(preservedRow.bytes) + staged.byteCount > limits.maxTotalBytesPerRevision) {
    const registered = database.prepare('SELECT id FROM assets WHERE sha256 = ?').get(staged.sha256);
    const deleteFilePath = registered ? null : staged.filePath;
    transitionMediaCandidate(database, {
      candidateId: candidate.id,
      to: 'skipped_limit',
      errorCode: 'MEDIA_LIMIT_EXCEEDED',
      errorMessage: `Source revision 归档字节超限（${Number(preservedRow.bytes) + staged.byteCount} > ${limits.maxTotalBytesPerRevision}）。`,
      retryAfter: null
    });
    writeArchiveAttempt(database, {
      candidateId: candidate.id,
      attempt: attemptNumber,
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      errorCode: 'MEDIA_LIMIT_EXCEEDED',
      errorMessage: 'Source revision 归档字节超限。'
    });
    database.prepare(`UPDATE jobs SET status = 'needs_user', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run('MEDIA_LIMIT_EXCEEDED', now, now, job.id);
    return {
      finished: true, stale: false, outcome: 'skipped_limit',
      candidate: getMediaCandidate(database, candidate.id), binding: null,
      jobStatus: 'needs_user', deleteFilePath
    };
  }

  const registered = registerStagedAsset(database, {
    id: randomUUID(),
    relativePath: staged.relativePath!,
    mimeType: staged.mimeType,
    byteCount: staged.byteCount,
    sha256: staged.sha256,
    origin: `source-media:${candidate.sourceRevisionKey}:${candidate.id}`,
    width: staged.width,
    height: staged.height,
    durationMs: staged.durationMs
  });
  const binding = completeMediaCandidatePreserved(database, {
    candidateId: candidate.id,
    sourceId: candidate.sourceId,
    sourceRevisionKey: candidate.sourceRevisionKey,
    assetId: registered.id,
    sha256: staged.sha256,
    capturedAt: now,
    kind: candidate.kind,
    ordinal: candidate.ordinal,
    originalUrl: candidate.originalUrl,
    caption: candidate.captionHint ?? null,
    rightsStatus: 'unknown',
    riskFlags: [],
    createdBy,
    requestId: candidate.requestId,
    archivedAt: now
  });
  writeArchiveAttempt(database, {
    candidateId: candidate.id,
    attempt: attemptNumber,
    status: 'succeeded',
    startedAt: now,
    finishedAt: now,
    runtimeName: staged.runtimeName ?? null,
    runtimeVersion: staged.runtimeVersion ?? null,
    parameterHash: parameterHashFor(staged, candidate)
  });
  database.prepare(`UPDATE jobs SET status = 'succeeded', last_error = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(now, now, job.id);
  return {
    finished: true, stale: false, outcome: 'preserved',
    candidate: getMediaCandidate(database, candidate.id), binding,
    jobStatus: 'succeeded', deleteFilePath: null
  };
}

function finishDiscoverJob(database: DatabaseSync, job: MediaArchiveJobRow, result: DiscoverExecutionOutcome, now: string): FinishResult {
  if (result.outcome === 'discovered') {
    if (result.candidates.length > 0) {
      insertMediaCandidates(database, {
        sourceId: String(job.payload.sourceId ?? ''),
        sourceRevisionKey: String(job.payload.sourceRevisionKey ?? ''),
        channel: result.channel,
        requestId: String(job.payload.workspaceId ?? ''),
        discoveredAt: now,
        candidates: result.candidates
      });
    }
    database.prepare(`UPDATE jobs SET status = 'succeeded', last_error = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(now, now, job.id);
    return { finished: true, stale: false, outcome: 'discovered', candidate: null, binding: null, jobStatus: 'succeeded', deleteFilePath: result.htmlPath };
  }
  const retryable = result.outcome === 'failed' && result.retryable;
  const maxAttempts = MEDIA_LIMITS_DEFAULT.maxAttempts;
  if (retryable && job.attempts < maxAttempts) {
    const dueAt = new Date(Date.parse(now) + mediaRetryBackoffMs(job.attempts)).toISOString();
    database.prepare(`UPDATE jobs SET status = 'pending', due_at = ?, last_error = ?, started_at = NULL, updated_at = ? WHERE id = ?`)
      .run(dueAt, `${result.code}: ${result.message}`, now, job.id);
    return { finished: true, stale: false, outcome: 'failed', candidate: null, binding: null, jobStatus: 'pending', deleteFilePath: null };
  }
  const terminal = retryable ? 'failed' : result.outcome;
  const terminalCode = retryable ? `${result.code}_RETRY_EXHAUSTED` : result.code;
  const jobStatus = FINISH_TERMINAL_JOB_STATUS[terminal] ?? 'failed';
  database.prepare(`UPDATE jobs SET status = ?, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(jobStatus, `${terminalCode}: ${result.message}`, now, now, job.id);
  return { finished: true, stale: false, outcome: terminal, candidate: null, binding: null, jobStatus, deleteFilePath: null };
}

// ============================================================
// 启动恢复（孤儿 running >15 分钟 → DOWNLOAD_INTERRUPTED，按 attempt 上限重试）
// ============================================================

export function recoverInterruptedMediaArchiveJobs(
  database: DatabaseSync,
  input: { staleAfterMs?: number; now?: string } = {}
): { recovered: number; exhausted: number } {
  const now = input.now ?? new Date().toISOString();
  const staleAfterMs = input.staleAfterMs ?? MEDIA_WORKER_TUNING.interruptedStaleMs;
  const cutoff = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const rows = database.prepare(`SELECT ${JOB_SELECT} FROM jobs
    WHERE kind IN (?, ?) AND status = 'running' AND updated_at <= ? ORDER BY updated_at`)
    .all(MEDIA_ARCHIVE_JOB_KIND, MEDIA_DISCOVER_JOB_KIND, cutoff) as Array<Record<string, unknown>>;
  let recovered = 0;
  let exhausted = 0;
  for (const row of rows) {
    const job = mapJobRow(row);
    const maxAttempts = job.kind === MEDIA_ARCHIVE_JOB_KIND
      ? (getMediaCandidate(database, String(job.payload.candidateId ?? ''))?.maxAttempts ?? MEDIA_DEFAULT_MAX_ATTEMPTS)
      : MEDIA_LIMITS_DEFAULT.maxAttempts;
    const canRetry = job.attempts < maxAttempts;
    if (job.kind === MEDIA_ARCHIVE_JOB_KIND) {
      const candidate = getMediaCandidate(database, String(job.payload.candidateId ?? ''));
      if (candidate && candidate.status === 'downloading') {
        writeArchiveAttempt(database, {
          candidateId: candidate.id,
          attempt: job.attempts,
          status: 'failed',
          startedAt: now,
          finishedAt: now,
          errorCode: 'DOWNLOAD_INTERRUPTED',
          errorMessage: '执行中断超过 15 分钟（进程崩溃或暂停），已恢复。'
        });
        transitionMediaCandidate(database, {
          candidateId: candidate.id,
          to: 'failed',
          errorCode: canRetry ? 'DOWNLOAD_INTERRUPTED' : 'DOWNLOAD_INTERRUPTED_RETRY_EXHAUSTED',
          errorMessage: '下载中断，等待重试。',
          retryAfter: canRetry ? now : null
        });
      }
    }
    if (canRetry) {
      database.prepare(`UPDATE jobs SET status = 'pending', due_at = ?, last_error = ?, started_at = NULL, updated_at = ? WHERE id = ?`)
        .run(now, 'DOWNLOAD_INTERRUPTED', now, job.id);
      recovered += 1;
    } else {
      database.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
        .run('DOWNLOAD_INTERRUPTED_RETRY_EXHAUSTED', now, now, job.id);
      exhausted += 1;
    }
  }
  return { recovered, exhausted };
}

// ============================================================
// 用户命令：归档重试 / 全局暂停（纯函数；IPC 经 dispatcher 调用）
// ============================================================

export type RetryMediaCandidateResult =
  | { ok: true; candidate: MediaCandidateRecord; job: { id: string; status: string; attempts: number; dueAt: string } }
  | { ok: false; code: string; message: string };

/**
 * 用户重试：仅允许从 failed 重试（新生命周期：候选回 pending、清错误、attempt_count=0；
 * jobs 重置 pending/due_at=now/attempts=0/last_error=NULL；attempts 历史不动，
 * 下次 claim 的执行序号顺延 MAX(attempt)+1，UNIQUE(candidate_id, attempt) 不冲突）。
 * 注：failed → pending 是唯一绕过 store 状态机的地方（用户显式重试重新武装生命周期）。
 */
export function retryMediaArchiveCandidate(database: DatabaseSync, candidateId: string): RetryMediaCandidateResult {
  const candidate = getMediaCandidate(database, candidateId);
  if (!candidate) return { ok: false, code: 'NOT_FOUND', message: `候选 ${candidateId} 不存在。` };
  if (candidate.status !== 'failed') {
    return { ok: false, code: 'INVALID_STATE', message: `只有 failed 候选可重试，当前状态 ${candidate.status}。` };
  }
  const now = new Date().toISOString();
  database.prepare(`UPDATE source_media_candidates SET
    status = 'pending', error_code = NULL, error_message = NULL, retry_after = NULL, attempt_count = 0, archived_at = NULL
    WHERE id = ? AND status = 'failed'`).run(candidateId);
  const dedupeKey = mediaArchiveDedupeKey(candidate.sourceRevisionKey, candidateId);
  database.prepare(`UPDATE jobs SET status = 'pending', due_at = ?, attempts = 0, last_error = NULL, started_at = NULL, finished_at = NULL, updated_at = ?
    WHERE dedupe_key = ? AND status IN ('failed', 'needs_user')`).run(now, now, dedupeKey);
  const job = findJobByDedupe(database, dedupeKey);
  return {
    ok: true,
    candidate: getMediaCandidate(database, candidateId)!,
    job: job ? { id: job.id, status: job.status, attempts: job.attempts, dueAt: job.dueAt } : { id: '', status: 'missing', attempts: 0, dueAt: now }
  };
}

// ============================================================
// 批量执行（direct-DB 模式：测试同步；生产模式：claim/finish 经 dispatcher 授权）
// ============================================================

export type RunDueMediaArchiveJobsResult = Readonly<{
  processed: number;
  preserved: number;
  failed: number;
  needsUser: number;
  unsupported: number;
  skippedLimit: number;
  discovered: number;
  stale: number;
}>;

async function runOneJobProduction(
  runtime: ActiveWorkspaceRuntime,
  job: MediaArchiveJobRow,
  deps: MediaArchiveWorkerDeps
): Promise<void> {
  const database = runtime.database;
  const dataRoot = runtime.identity.rootPath;
  // 1. claim（事务内）
  // requestId 绑定「运行时激活 + job 生命周期」：updatedAt 在用户重试（attempts 归零）时变化，
  // 保证重试后的新执行不复用旧生命周期回执（避免 REQUEST_REPLAY_CONFLICT / 陈旧回放）。
  const claimRequestId = `media-archive:${job.id}:claim:${runtime.identity.runtimeEpoch}:${job.attempts}:${job.updatedAt}`;
  const claimReceipt = await dispatchBusinessCommand(runtime, {
    command: MEDIA_ARCHIVE_CLAIM_COMMAND,
    requestId: claimRequestId,
    actor: schedulerActor,
    input: { jobId: job.id, expectedAttempts: job.attempts },
    boundIdentity: runtime.identity,
    entityType: 'media_archive_job',
    execute: (db, normalizedInput) => {
      const result = claimMediaArchiveJob(db, normalizedInput.jobId, normalizedInput.expectedAttempts, { requestId: claimRequestId });
      return { data: result, entityId: job.id };
    }
  });
  const claimData = requireReceiptData(claimReceipt);
  if (!claimData.claimed) {
    if (claimData.reason === 'CANDIDATE_NOT_FOUND') broadcastDataChanged({ scopes: ['sources', 'media'], reason: 'media.archive' });
    return;
  }

  // 2. 下载（事务外）
  const execution = job.kind === MEDIA_DISCOVER_JOB_KIND
    ? await executeMediaDiscover(database, claimData.job, dataRoot, deps)
    : await executeMediaArchiveCandidate(database, claimData.candidate!.id, claimData.attemptNumber, dataRoot, deps);

  // 3. finish（事务内）
  const expectedAttempts = claimData.job.attempts;
  // 用「claimed 行的 updatedAt」（claim 写入的新时间戳）作为本生命周期终态 token：
  // 与 claim 的 pending-updatedAt 天然不同，且重试后的新生命周期也必然不同。
  const finishRequestId = `media-archive:${job.id}:finish:${runtime.identity.runtimeEpoch}:${expectedAttempts}:${claimData.job.updatedAt}`;
  const finishReceipt = await dispatchBusinessCommand(runtime, {
    command: MEDIA_ARCHIVE_FINISH_COMMAND,
    requestId: finishRequestId,
    actor: schedulerActor,
    input: { jobId: job.id, expectedAttempts, result: execution },
    boundIdentity: runtime.identity,
    entityType: 'media_archive_job',
    execute: (db, normalizedInput) => {
      const result = finishMediaArchiveJob(db, {
        jobId: normalizedInput.jobId,
        expectedAttempts: normalizedInput.expectedAttempts,
        result: normalizedInput.result,
        createdBy: 'media-archive-worker'
      });
      return { data: result, entityId: job.id };
    }
  });
  const finishData = requireReceiptData(finishReceipt);
  if (finishData.deleteFilePath) {
    await rm(finishData.deleteFilePath, { force: true }).catch(() => {});
  }
  if (finishData.outcome === 'preserved' && finishData.binding) {
    const asset = database.prepare('SELECT id, mime_type AS mimeType FROM assets WHERE id = ?').get(finishData.binding.assetId) as { id: string; mimeType: string } | undefined;
    callPostPreserveHook(database, {
      sourceId: finishData.binding.sourceId,
      sourceRevisionKey: finishData.binding.sourceRevisionKey,
      assetId: finishData.binding.assetId,
      kind: finishData.binding.kind
    });
    void asset;
  }
  broadcastDataChanged({ scopes: ['sources', 'media'], reason: 'media.archive' });
}

async function runOneJobDirect(
  database: DatabaseSync,
  job: MediaArchiveJobRow,
  deps: MediaArchiveWorkerDeps,
  dataRoot: string
): Promise<void> {
  const claim = claimMediaArchiveJob(database, job.id, job.attempts, { requestId: `media-archive:${job.id}:claim:${job.attempts}` });
  if (!claim.claimed) return;
  const execution = job.kind === MEDIA_DISCOVER_JOB_KIND
    ? await executeMediaDiscover(database, claim.job, dataRoot, deps)
    : await executeMediaArchiveCandidate(database, claim.candidate!.id, claim.attemptNumber, dataRoot, deps);
  const finish = finishMediaArchiveJob(database, {
    jobId: job.id,
    expectedAttempts: claim.job.attempts,
    result: execution,
    createdBy: 'media-archive-worker'
  });
  if (finish.deleteFilePath) {
    await rm(finish.deleteFilePath, { force: true }).catch(() => {});
  }
  if (finish.outcome === 'preserved' && finish.binding) {
    callPostPreserveHook(database, {
      sourceId: finish.binding.sourceId,
      sourceRevisionKey: finish.binding.sourceRevisionKey,
      assetId: finish.binding.assetId,
      kind: finish.binding.kind
    });
  }
  broadcastDataChanged({ scopes: ['sources', 'media'], reason: 'media.archive' });
}

/**
 * 处理到期的媒体归档 jobs（并发 = MEDIA_ARCHIVE_CONCURRENCY）。
 * - DatabaseSync：直连/测试模式（同步执行，无 dispatcher 授权层；dataRoot 必传）。
 * - ActiveWorkspaceRuntime：生产模式（claim/finish 经 dispatchBusinessCommand 授权执行）。
 */
export async function runDueMediaArchiveJobs(
  dependency: ActiveWorkspaceRuntime | DatabaseSync,
  input: { isCurrent?: () => boolean; limit?: number; deps?: MediaArchiveWorkerDeps; dataRoot?: string } = {}
): Promise<RunDueMediaArchiveJobsResult> {
  const database = 'database' in dependency ? dependency.database : dependency;
  const dataRoot = 'database' in dependency ? dependency.identity.rootPath : (input.dataRoot ?? '');
  const limit = Math.min(Math.max(input.limit ?? MEDIA_ARCHIVE_CONCURRENCY, 1), 50);
  const due = listDueMediaJobs(database, { limit });
  const result = { processed: 0, preserved: 0, failed: 0, needsUser: 0, unsupported: 0, skippedLimit: 0, discovered: 0, stale: 0 };
  for (const job of due) {
    if (input.isCurrent && !input.isCurrent()) break;
    if (isMediaArchivePaused(database)) break;
    result.processed += 1;
    if ('database' in dependency) {
      await runOneJobProduction(dependency, job, input.deps ?? {});
    } else {
      await runOneJobDirect(database, job, input.deps ?? {}, dataRoot);
    }
    const outcome = outcomeOf(database, job);
    if (outcome === 'preserved') result.preserved += 1;
    else if (outcome === 'failed') result.failed += 1;
    else if (outcome === 'needs_user') result.needsUser += 1;
    else if (outcome === 'unsupported') result.unsupported += 1;
    else if (outcome === 'skipped_limit') result.skippedLimit += 1;
    else if (outcome === 'discovered') result.discovered += 1;
    else result.stale += 1;
  }
  return result;
}

function outcomeOf(database: DatabaseSync, job: MediaArchiveJobRow): string {
  const current = getJobRow(database, job.id);
  if (!current) return 'stale';
  if (current.status === 'succeeded') {
    if (current.kind === MEDIA_DISCOVER_JOB_KIND) return 'discovered';
    const candidate = getMediaCandidate(database, String(current.payload.candidateId ?? ''));
    return candidate?.status ?? 'preserved';
  }
  if (current.status === 'pending' || current.status === 'running') return 'failed'; // 退避重排
  if (current.status === 'needs_user') {
    // 终态落位由候选七态决定（skipped_limit/unsupported/needs_user）。
    if (current.kind === MEDIA_DISCOVER_JOB_KIND) return 'needs_user';
    const candidate = getMediaCandidate(database, String(current.payload.candidateId ?? ''));
    if (candidate?.status === 'skipped_limit') return 'skipped_limit';
    if (candidate?.status === 'unsupported') return 'unsupported';
    return 'needs_user';
  }
  return 'failed';
}

// ============================================================
// 读模型（Source 详情；设计 §12.1 计数口径 = 当前 revision 候选总数与 preserved 数）
// ============================================================

export type SourceMediaSummary = Readonly<{
  total: number;
  preserved: number;
  downloading: number;
  pending: number;
  failed: number;
  unsupported: number;
  needsUser: number;
  skippedLimit: number;
  preservedBytes: number;
}>;

export function getSourceMediaSummary(database: DatabaseSync, sourceId: string, sourceRevisionKeyValue: string): SourceMediaSummary {
  const counts = mediaArchiveStatusSummary(database, sourceRevisionKeyValue);
  const bytes = database.prepare(`SELECT COALESCE(SUM(a.byte_count), 0) AS bytes
    FROM source_media_bindings b JOIN assets a ON a.id = b.asset_id
    WHERE b.source_revision_key = ? AND b.archived_at IS NULL AND b.source_id = ?`).get(sourceRevisionKeyValue, sourceId) as { bytes: number };
  return {
    total: counts.total,
    preserved: counts.preserved,
    downloading: counts.downloading,
    pending: counts.pending,
    failed: counts.failed,
    unsupported: counts.unsupported,
    needsUser: counts.needsUser,
    skippedLimit: counts.skippedLimit,
    preservedBytes: Number(bytes.bytes)
  };
}

export type SourceMediaItem = Readonly<{
  candidateId: string;
  kind: MediaCandidateKind;
  ordinal: number;
  status: string;
  originalUrl: string;
  alternateUrls: string[];
  captionHint: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  discoveredAt: string;
  archivedAt: string | null;
  postKind: string | null;
  postOrdinal: number | null;
  ordinalInPost: number | null;
  parentCandidateId: string | null;
  assetId: string | null;
  assetRelativePath: string | null;
  assetMimeType: string | null;
  assetByteCount: number | null;
  assetWidth: number | null;
  assetHeight: number | null;
  assetDurationMs: number | null;
  sha256: string | null;
  rightsStatus: string | null;
  riskFlags: string[];
  bindingId: string | null;
}>;

/** Source 详情列表：候选 + 绑定 + Asset（LEFT JOIN；未保存媒体 asset 字段为 null）。 */
export function listSourceMedia(database: DatabaseSync, sourceId: string, sourceRevisionKeyValue: string): SourceMediaItem[] {
  const rows = database.prepare(`SELECT
    c.id AS candidateId, c.kind, c.ordinal, c.status, c.original_url AS originalUrl, c.alternate_urls_json AS alternateUrlsJson,
    c.caption_hint AS captionHint, c.error_code AS errorCode, c.error_message AS errorMessage,
    c.attempt_count AS attemptCount, c.max_attempts AS maxAttempts, c.discovered_at AS discoveredAt, c.archived_at AS archivedAt,
    c.post_kind AS postKind, c.post_ordinal AS postOrdinal, c.ordinal_in_post AS ordinalInPost, c.parent_candidate_id AS parentCandidateId,
    b.id AS bindingId, b.asset_id AS assetId, b.sha256, b.rights_status AS rightsStatus, b.risk_flags_json AS riskFlagsJson,
    a.relative_path AS assetRelativePath, a.mime_type AS assetMimeType, a.byte_count AS assetByteCount,
    a.width AS assetWidth, a.height AS assetHeight, a.duration_ms AS assetDurationMs
    FROM source_media_candidates c
    LEFT JOIN source_media_bindings b ON b.candidate_id = c.id AND b.source_id = c.source_id
    LEFT JOIN assets a ON a.id = b.asset_id
    WHERE c.source_id = ? AND c.source_revision_key = ?
    ORDER BY c.ordinal, c.kind, c.id`).all(sourceId, sourceRevisionKeyValue) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    candidateId: String(row.candidateId),
    kind: row.kind as MediaCandidateKind,
    ordinal: Number(row.ordinal),
    status: String(row.status),
    originalUrl: String(row.originalUrl),
    alternateUrls: parseAlternateUrls(row.alternateUrlsJson),
    captionHint: (row.captionHint as string | null) ?? null,
    errorCode: (row.errorCode as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    discoveredAt: String(row.discoveredAt),
    archivedAt: (row.archivedAt as string | null) ?? null,
    postKind: (row.postKind as string | null) ?? null,
    postOrdinal: (row.postOrdinal as number | null) ?? null,
    ordinalInPost: (row.ordinalInPost as number | null) ?? null,
    parentCandidateId: (row.parentCandidateId as string | null) ?? null,
    assetId: (row.assetId as string | null) ?? null,
    assetRelativePath: (row.assetRelativePath as string | null) ?? null,
    assetMimeType: (row.assetMimeType as string | null) ?? null,
    assetByteCount: (row.assetByteCount as number | null) ?? null,
    assetWidth: (row.assetWidth as number | null) ?? null,
    assetHeight: (row.assetHeight as number | null) ?? null,
    assetDurationMs: (row.assetDurationMs as number | null) ?? null,
    sha256: (row.sha256 as string | null) ?? null,
    rightsStatus: (row.rightsStatus as string | null) ?? null,
    riskFlags: parseRiskFlags(row.riskFlagsJson),
    bindingId: (row.bindingId as string | null) ?? null
  }));
}

function parseAlternateUrls(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseRiskFlags(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export type { MediaArchiveAttemptRecord, MediaCandidateRecord, SourceMediaBindingRecord };
export { listMediaCandidatesForRevision, listSourceMediaBindings, listArchiveAttempts, getArchiveAttempt, getMediaCandidate, mediaArchiveStatusSummary, stableRemoteIdentity };

// ============================================================
// 调度器（生产模式；与 KnowledgeLintScheduler / XObservationScheduler 同构：
// 到期轮询 + 完成唤醒；不新建调度基础设施）
// ============================================================

const DEFAULT_SCHEDULER_INTERVAL_MS = 5_000;

/**
 * 媒体归档调度器：
 * - 首 tick 与周期执行启动恢复（孤儿 running >15 分钟 → DOWNLOAD_INTERRUPTED）；
 * - 每 tick 处理到期 jobs（并发 = MEDIA_ARCHIVE_CONCURRENCY）；全局暂停时停止 claim；
 * - 完成唤醒（rerun）保证并发持续灌满。
 */
export class MediaArchiveScheduler {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private rerun = false;
  private generation = 0;
  private recovered = false;
  private readonly options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number; deps?: MediaArchiveWorkerDeps };

  constructor(options: { runtime: ActiveWorkspaceRuntime; isCurrent?: () => boolean; intervalMs?: number; deps?: MediaArchiveWorkerDeps }) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.recovered = false;
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
      if (!this.recovered) {
        try {
          // WMB-5301：启动恢复也必须走命令调度（写护栏 WMB_WRITE_REQUIRES_COMMAND_DISPATCH）。
          // requestId 绑定运行时激活（runtimeEpoch）+ 调度器代际，保证每次调度器启动都真实执行恢复，
          // 且不会与上一次应用启动的恢复回执冲突/回放。
          const recovery = await dispatchBusinessCommand(runtime, {
            command: MEDIA_ARCHIVE_RECOVER_COMMAND,
            requestId: `media-archive:recover:${runtime.identity.runtimeEpoch}:${generation}`,
            actor: schedulerActor,
            input: {},
            boundIdentity: runtime.identity,
            entityType: 'media_archive_job',
            execute: (db) => ({ data: recoverInterruptedMediaArchiveJobs(db, {}) })
          });
          const recovered = requireReceiptData(recovery);
          if (recovered.recovered > 0 || recovered.exhausted > 0) {
            broadcastDataChanged({ scopes: ['sources', 'media'], reason: 'media.archive.recover' });
          }
        } catch (error) {
          console.error('[media-archive] startup recovery failed', error);
        }
        this.recovered = true;
      }
      try {
        const drained = await runDueMediaArchiveJobs(runtime, {
          isCurrent: () => !this.stopped && generation === this.generation && runtime.isActive && (!this.options.isCurrent || this.options.isCurrent()),
          limit: MEDIA_ARCHIVE_CONCURRENCY,
          deps: this.options.deps
        });
        // 有界批处理（每 tick 最多并发 3）：仍有积压时立即续跑（并发仍受 3 约束，非忙等）。
        if (drained.processed > 0 && !this.stopped && generation === this.generation) {
          this.wake();
        }
      } catch (error) {
        console.error('[media-archive] scheduler tick failed', error);
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
