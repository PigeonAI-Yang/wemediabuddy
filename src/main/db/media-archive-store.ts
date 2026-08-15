// WMB-5244：情报媒体候选/归档同步存储原语（设计 §6/§7/§8）。
// 只做 DB 读写原语：渠道接线 / 归档 worker / 启动恢复在各自授权事务内调用；
// 本模块不 BEGIN/COMMIT（data-root-safe：可嵌套在调用方事务与 SAVEPOINT 内），
// 不创建临时表/触发器，不接触 dispatcher/read-model 之外的职责。
//
// 幂等契约（确定性 ID + 唯一键）：
// - insertMediaCandidates：同 (sourceRevisionKey, ordinal, kind) 已存在 → 复用既有 candidate，
//   不重复写 Attempt/Job；同 URL 不同 ordinal（主帖图 + 引用帖图）保留为独立候选，
//   字节级去重由 Asset sha256 承担。
// - completeMediaCandidatePreserved：preserved 是终态；同 candidate 重放只补缺失行，不覆盖；
//   同 (sourceRevisionKey, asset_id) 已绑定 → 复用既有 Binding（不重复 Provenance）。
// - 失败 Attempt 行不被后续 attempt 覆盖（UNIQUE(candidate_id, attempt) 新行）。

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MEDIA_ARCHIVE_JOB_KIND,
  MEDIA_DISCOVER_JOB_KIND,
  MEDIA_DEFAULT_MAX_ATTEMPTS,
  mediaArchiveDedupeKey,
  mediaDiscoverDedupeKey,
  normalizeRemoteUrl,
  type MediaArchiveAttemptStatus,
  type MediaCandidateKind,
  type MediaCandidateStatus,
  type MediaChannel,
  type MediaPostKind,
  type MediaRightsStatus
} from '../../shared/media-candidates.ts';
import { MEDIA_LIMITS_DEFAULT } from '../../shared/media-limits.ts';

// ---------------------------------------------------------------------------
// 记录类型（与迁移 64 DDL 逐列对应）
// ---------------------------------------------------------------------------

export type MediaCandidateRecord = Readonly<{
  id: string;
  sourceId: string;
  sourceRevisionKey: string;
  kind: MediaCandidateKind;
  originalUrl: string;
  stableRemoteIdentity: string;
  channel: MediaChannel;
  postKind: MediaPostKind | null;
  parentCandidateId: string | null;
  postOrdinal: number | null;
  ordinalInPost: number | null;
  ordinal: number;
  captionHint: string | null;
  surroundingText: string | null;
  status: MediaCandidateStatus;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  retryAfter: string | null;
  requestId: string | null;
  discoveredAt: string;
  archivedAt: string | null;
  /** 下载回退链（orig→medium→thumb 等）；已解析 JSON。 */
  alternateUrls: string[];
}>;

export type MediaArchiveAttemptRecord = Readonly<{
  id: string;
  candidateId: string;
  attempt: number;
  status: MediaArchiveAttemptStatus;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  runtimeName: string | null;
  runtimeVersion: string | null;
  parameterHash: string | null;
}>;

export type SourceMediaBindingRecord = Readonly<{
  id: string;
  sourceId: string;
  sourceRevisionKey: string;
  candidateId: string;
  assetId: string;
  kind: MediaCandidateKind;
  ordinal: number;
  originalUrl: string;
  caption: string | null;
  sha256: string;
  capturedAt: string;
  rightsStatus: MediaRightsStatus;
  riskFlagsJson: string;
  createdAt: string;
  createdBy: string;
  archivedAt: string | null;
  archivedReason: string | null;
}>;

/** media_archive job payload（设计 §6.4：仅含四个字段）。 */
export type MediaArchiveJobPayload = Readonly<{
  workspaceId: string;
  sourceId: string;
  sourceRevisionKey: string;
  candidateId: string;
}>;

/** media_discover job payload（设计 §7.4：重抓固定原 URL）。 */
export type MediaDiscoverJobPayload = Readonly<{
  workspaceId: string;
  sourceId: string;
  sourceRevisionKey: string;
  originalUrl: string;
}>;

// ---------------------------------------------------------------------------
// 写入输入
// ---------------------------------------------------------------------------

export type MediaCandidateInput = Readonly<{
  kind: MediaCandidateKind;
  originalUrl: string;
  /** 单个候选渠道覆盖；省略时使用 InsertMediaCandidatesInput.channel（单渠道批次推荐）。 */
  channel?: MediaChannel;
  /** tweet | repost | quote | web；X 引用帖媒体必须保留。 */
  postKind?: MediaPostKind | null;
  /** 父候选 ordinal（同 revision 批内）：poster→视频、引用帖媒体→引用父媒体；无则省略。 */
  parentOrdinal?: number | null;
  postOrdinal?: number | null;
  ordinalInPost?: number | null;
  /** 全局媒体序（帖子顺序再媒体顺序；跨 kind 唯一）。 */
  ordinal: number;
  captionHint?: string | null;
  surroundingText?: string | null;
  maxAttempts?: number;
  /** 预置状态：仅 'skipped_limit'（超出 Source 策略，不建 Attempt/Job，不自动重试）；省略则 pending。 */
  status?: 'skipped_limit';
  /** 下载回退链（设计 §7.2 图片 orig→medium→thumb 等）；首元素不重复 originalUrl。 */
  alternateUrls?: readonly string[];
}>;

export type InsertMediaCandidatesInput = Readonly<{
  sourceId: string;
  sourceRevisionKey: string;
  channel: MediaChannel;
  requestId: string;
  discoveredAt: string;
  candidates: readonly MediaCandidateInput[];
}>;

export type InsertMediaCandidatesResult = Readonly<{
  candidateIds: string[];
  inserted: string[];
  reused: string[];
}>;

export type PreserveMediaCandidateInput = Readonly<{
  candidateId: string;
  sourceId: string;
  sourceRevisionKey: string;
  assetId: string;
  sha256: string;
  capturedAt: string;
  kind: MediaCandidateKind;
  ordinal: number;
  originalUrl: string;
  caption?: string | null;
  rightsStatus?: MediaRightsStatus;
  riskFlags?: readonly string[];
  createdBy: string;
  requestId?: string | null;
  archivedAt?: string;
}>;

export type MediaCandidateTransitionInput = Readonly<{
  candidateId: string;
  to: Exclude<MediaCandidateStatus, 'pending'>;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryAfter?: string | null;
  archivedAt?: string;
}>;

export type ArchiveAttemptWriteInput = Readonly<{
  candidateId: string;
  attempt: number;
  status: MediaArchiveAttemptStatus;
  startedAt: string;
  finishedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  runtimeName?: string | null;
  runtimeVersion?: string | null;
  parameterHash?: string | null;
}>;

// ---------------------------------------------------------------------------
// 状态机（设计 §8 状态分类）
// ---------------------------------------------------------------------------

/** 允许的候选状态迁移；终态 preserved/unsupported/skipped_limit 不可自动迁移。
 *  preserved 只能经 completeMediaCandidatePreserved（同事务写 Binding+Provenance）到达，
 *  不允许经 transitionMediaCandidate 裸转（否则破坏「preserved = 同事务存在 Binding」不变量）。 */
const CANDIDATE_TRANSITIONS: Readonly<Record<MediaCandidateStatus, readonly MediaCandidateStatus[]>> = Object.freeze({
  pending: ['downloading', 'failed', 'unsupported', 'needs_user', 'skipped_limit'],
  downloading: ['failed', 'unsupported', 'needs_user', 'skipped_limit'],
  failed: ['downloading', 'needs_user', 'unsupported', 'skipped_limit'],
  needs_user: ['downloading', 'failed'],
  preserved: [],
  unsupported: [],
  skipped_limit: []
});

function assertAllowedTransition(from: MediaCandidateStatus, to: MediaCandidateStatus): void {
  if (!CANDIDATE_TRANSITIONS[from].includes(to)) {
    throw new Error(`媒体候选状态迁移非法: ${from} -> ${to}`);
  }
}

// ---------------------------------------------------------------------------
// 身份与行映射
// ---------------------------------------------------------------------------

/** sha256(normalizedUrl)：稳定远程身份（设计 §6.1）。非 http(s) 原样哈希，由调用方校验。 */
export function stableRemoteIdentity(url: string): string {
  return createHash('sha256').update(normalizeRemoteUrl(url)).digest('hex');
}

const CANDIDATE_COLUMNS = `id, source_id AS sourceId, source_revision_key AS sourceRevisionKey, kind, original_url AS originalUrl,
  stable_remote_identity AS stableRemoteIdentity, channel, post_kind AS postKind, parent_candidate_id AS parentCandidateId,
  post_ordinal AS postOrdinal, ordinal_in_post AS ordinalInPost, ordinal, caption_hint AS captionHint,
  surrounding_text AS surroundingText, status, error_code AS errorCode, error_message AS errorMessage,
  attempt_count AS attemptCount, max_attempts AS maxAttempts, retry_after AS retryAfter, request_id AS requestId,
  discovered_at AS discoveredAt, archived_at AS archivedAt, alternate_urls_json AS alternateUrlsJson`;

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapCandidateRow(row: Record<string, unknown>): MediaCandidateRecord {
  return {
    id: String(row.id),
    sourceId: String(row.sourceId),
    sourceRevisionKey: String(row.sourceRevisionKey),
    kind: row.kind as MediaCandidateKind,
    originalUrl: String(row.originalUrl),
    stableRemoteIdentity: String(row.stableRemoteIdentity),
    channel: row.channel as MediaChannel,
    postKind: (row.postKind as MediaPostKind | null) ?? null,
    parentCandidateId: (row.parentCandidateId as string | null) ?? null,
    postOrdinal: (row.postOrdinal as number | null) ?? null,
    ordinalInPost: (row.ordinalInPost as number | null) ?? null,
    ordinal: Number(row.ordinal),
    captionHint: (row.captionHint as string | null) ?? null,
    surroundingText: (row.surroundingText as string | null) ?? null,
    status: row.status as MediaCandidateStatus,
    errorCode: (row.errorCode as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    retryAfter: (row.retryAfter as string | null) ?? null,
    requestId: (row.requestId as string | null) ?? null,
    discoveredAt: String(row.discoveredAt),
    archivedAt: (row.archivedAt as string | null) ?? null,
    alternateUrls: parseStringArray(row.alternateUrlsJson)
  };
}

function candidateIdFor(sourceRevisionKeyValue: string, ordinal: number, kind: MediaCandidateKind): string {
  return `smc:${sourceRevisionKeyValue}:${ordinal}:${kind}`;
}

// ---------------------------------------------------------------------------
// 候选写入（设计 §7.1：Candidate + 初始 Attempt + Job 同事务；本函数零事务，调用方包裹）
// ---------------------------------------------------------------------------

const INSERT_CANDIDATE_SQL = `INSERT INTO source_media_candidates (
  id, source_id, source_revision_key, kind, original_url, stable_remote_identity, channel, post_kind,
  parent_candidate_id, post_ordinal, ordinal_in_post, ordinal, caption_hint, surrounding_text,
  status, attempt_count, max_attempts, request_id, discovered_at, alternate_urls_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
ON CONFLICT (source_revision_key, ordinal, kind) DO NOTHING`;

const INSERT_ATTEMPT_SQL = `INSERT INTO media_archive_attempts (
  candidate_id, attempt, status, started_at
) VALUES (?, 1, 'running', ?)
ON CONFLICT (candidate_id, attempt) DO NOTHING`;

const INSERT_ARCHIVE_JOB_SQL = `INSERT INTO jobs (
  id, kind, status, due_at, attempts, dedupe_key, payload_json, created_at, updated_at
) VALUES (?, ?, 'pending', ?, 0, ?, ?, ?, ?)
ON CONFLICT (dedupe_key) DO NOTHING`;

function findCandidateByOrdinal(
  database: DatabaseSync,
  sourceRevisionKeyValue: string,
  ordinal: number,
  kind: MediaCandidateKind | null
): MediaCandidateRecord | null {
  const row = kind
    ? database
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM source_media_candidates
           WHERE source_revision_key = ? AND ordinal = ? AND kind = ?`
        )
        .get(sourceRevisionKeyValue, ordinal, kind)
    : database
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM source_media_candidates
           WHERE source_revision_key = ? AND ordinal = ? ORDER BY kind`
        )
        .get(sourceRevisionKeyValue, ordinal);
  return row ? mapCandidateRow(row as Record<string, unknown>) : null;
}

/**
 * 原子（调用方事务内）写入一批候选 + 各自初始 Attempt（attempt=1）+ media_archive Job。
 * 幂等：同 revision 重放 → 复用既有 candidate，不重复写 Attempt/Job。
 * 返回本次落库/复用的 candidate id（与输入序一致）。
 */
export function insertMediaCandidates(database: DatabaseSync, input: InsertMediaCandidatesInput): InsertMediaCandidatesResult {
  if (!input.candidates.length) return { candidateIds: [], inserted: [], reused: [] };
  if (input.candidates.length > MEDIA_LIMITS_DEFAULT.maxImagesPerRevision + MEDIA_LIMITS_DEFAULT.maxVideosPerRevision) {
    throw new Error(`单次候选批量超限: ${input.candidates.length}`);
  }
  const now = input.discoveredAt;
  const workspaceId = database
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('workspace_id') as { value: string } | undefined;
  const workspaceIdValue = workspaceId?.value ?? 'default';

  const insertCandidate = database.prepare(INSERT_CANDIDATE_SQL);
  const insertAttempt = database.prepare(INSERT_ATTEMPT_SQL);
  const insertJob = database.prepare(INSERT_ARCHIVE_JOB_SQL);

  const candidateIds: string[] = [];
  const inserted: string[] = [];
  const reused: string[] = [];

  // 第一遍落库（确定 parentCandidateId 前，poster 父引用在第二遍解析）。
  for (const candidate of input.candidates) {
    const id = candidateIdFor(input.sourceRevisionKey, candidate.ordinal, candidate.kind);
    const result = insertCandidate.run(
      id,
      input.sourceId,
      input.sourceRevisionKey,
      candidate.kind,
      candidate.originalUrl,
      stableRemoteIdentity(candidate.originalUrl),
      candidate.channel ?? input.channel,
      candidate.postKind ?? null,
      null, // parent_candidate_id 第二遍解析
      candidate.postOrdinal ?? null,
      candidate.ordinalInPost ?? null,
      candidate.ordinal,
      candidate.captionHint ?? null,
      candidate.surroundingText ?? null,
      candidate.status ?? 'pending',
      candidate.maxAttempts ?? MEDIA_DEFAULT_MAX_ATTEMPTS,
      input.requestId,
      now,
      JSON.stringify(candidate.alternateUrls ?? [])
    );
    candidateIds.push(id);
    if (result.changes > 0) inserted.push(id);
    else reused.push(id);
  }

  // 第二遍解析 parent_candidate_id：poster → 视频父候选；引用帖媒体 → 同 kind 父候选。
  const updateParent = database.prepare('UPDATE source_media_candidates SET parent_candidate_id = ? WHERE id = ?');
  for (const candidate of input.candidates) {
    if (candidate.parentOrdinal == null) continue;
    const parent =
      findCandidateByOrdinal(database, input.sourceRevisionKey, candidate.parentOrdinal, null) ??
      // poster 未命中同 kind 时回退 video（X 视频 poster 语义）。
      findCandidateByOrdinal(database, input.sourceRevisionKey, candidate.parentOrdinal, 'video');
    if (!parent || parent.id === candidateIdFor(input.sourceRevisionKey, candidate.ordinal, candidate.kind)) continue;
    updateParent.run(parent.id, candidateIdFor(input.sourceRevisionKey, candidate.ordinal, candidate.kind));
  }

  // 初始 Attempt + media_archive Job（每 candidate 一次；幂等）。
  // skipped_limit 候选（超出 Source 策略）不建 Attempt/Job、不自动重试（设计 §8）。
  for (const candidate of input.candidates) {
    if (candidate.status === 'skipped_limit') continue;
    const id = candidateIdFor(input.sourceRevisionKey, candidate.ordinal, candidate.kind);
    if (!inserted.includes(id)) continue;
    insertAttempt.run(id, now);
    insertJob.run(
      randomUUID(),
      MEDIA_ARCHIVE_JOB_KIND,
      now,
      mediaArchiveDedupeKey(input.sourceRevisionKey, id),
      JSON.stringify({ workspaceId: workspaceIdValue, sourceId: input.sourceId, sourceRevisionKey: input.sourceRevisionKey, candidateId: id } satisfies MediaArchiveJobPayload),
      now,
      now
    );
  }

  return { candidateIds, inserted, reused };
}

/** 独立入队 media_archive job（幂等：dedupe_key 已存在则不重复；恢复/重试路径用）。 */
export function enqueueMediaArchiveJob(
  database: DatabaseSync,
  payload: MediaArchiveJobPayload,
  dueAt = new Date().toISOString()
): void {
  const workspaceId = database.prepare('SELECT value FROM app_meta WHERE key = ?').get('workspace_id') as
    | { value: string }
    | undefined;
  const resolved = workspaceId?.value ?? 'default';
  database
    .prepare(INSERT_ARCHIVE_JOB_SQL)
    .run(
      randomUUID(),
      MEDIA_ARCHIVE_JOB_KIND,
      dueAt,
      mediaArchiveDedupeKey(payload.sourceRevisionKey, payload.candidateId),
      JSON.stringify({ ...payload, workspaceId: resolved }),
      dueAt,
      dueAt
    );
}

/** 独立入队 media_discover job（无结构化候选时重抓原 URL；按 revision 幂等）。 */
export function enqueueMediaDiscoverJob(database: DatabaseSync, payload: MediaDiscoverJobPayload): void {
  const workspaceId = database.prepare('SELECT value FROM app_meta WHERE key = ?').get('workspace_id') as
    | { value: string }
    | undefined;
  const resolved = workspaceId?.value ?? 'default';
  const now = new Date().toISOString();
  database
    .prepare(INSERT_ARCHIVE_JOB_SQL)
    .run(
      randomUUID(),
      MEDIA_DISCOVER_JOB_KIND,
      now,
      mediaDiscoverDedupeKey(payload.sourceRevisionKey),
      JSON.stringify({ ...payload, workspaceId: resolved }),
      now,
      now
    );
}

// ---------------------------------------------------------------------------
// Attempt 写入（设计 §6.2：每次执行一行；attempt=1 初始行预建，重试新行）
// ---------------------------------------------------------------------------

const UPSERT_ATTEMPT_SQL = `INSERT INTO media_archive_attempts (
  candidate_id, attempt, status, error_code, error_message, started_at, finished_at,
  runtime_name, runtime_version, parameter_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (candidate_id, attempt) DO UPDATE SET
  status = excluded.status,
  error_code = excluded.error_code,
  error_message = excluded.error_message,
  finished_at = excluded.finished_at,
  runtime_name = excluded.runtime_name,
  runtime_version = excluded.runtime_version,
  parameter_hash = excluded.parameter_hash`;

/**
 * 写入/推进一次归档尝试（attempt=1 为 Source 事务预建行；重试为 (candidate_id, attempt) 新行，
 * 旧失败行不被覆盖）。同时把 candidate.attempt_count 推进到 attempt 值。
 */
export function writeArchiveAttempt(database: DatabaseSync, input: ArchiveAttemptWriteInput): MediaArchiveAttemptRecord {
  database
    .prepare(UPSERT_ATTEMPT_SQL)
    .run(
      input.candidateId,
      input.attempt,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.startedAt,
      input.finishedAt ?? null,
      input.runtimeName ?? null,
      input.runtimeVersion ?? null,
      input.parameterHash ?? null
    );
  database
    .prepare('UPDATE source_media_candidates SET attempt_count = ? WHERE id = ?')
    .run(Math.max(input.attempt, 0), input.candidateId);
  return getArchiveAttempt(database, input.candidateId, input.attempt)!;
}

// ---------------------------------------------------------------------------
// 候选状态迁移（设计 §8）
// ---------------------------------------------------------------------------

/**
 * 候选状态迁移（状态机约束见 CANDIDATE_TRANSITIONS）。
 * preserved 只能经 completeMediaCandidatePreserved（同事务写 Binding）。
 */
export function transitionMediaCandidate(database: DatabaseSync, input: MediaCandidateTransitionInput): MediaCandidateRecord {
  const before = getMediaCandidate(database, input.candidateId);
  if (!before) throw new Error(`候选不存在: ${input.candidateId}`);
  assertAllowedTransition(before.status, input.to);
  database
    .prepare(
      `UPDATE source_media_candidates SET status = ?, error_code = ?, error_message = ?, retry_after = ?,
        archived_at = COALESCE(?, archived_at)
       WHERE id = ?`
    )
    .run(input.to, input.errorCode ?? null, input.errorMessage ?? null, input.retryAfter ?? null, input.archivedAt ?? null, input.candidateId);
  return getMediaCandidate(database, input.candidateId)!;
}

// ---------------------------------------------------------------------------
// preserved：Binding + Provenance + 候选终态（设计 §6.3 / §8 preserved 定义）
// ---------------------------------------------------------------------------

const INSERT_BINDING_SQL = `INSERT INTO source_media_bindings (
  id, source_id, source_revision_key, candidate_id, asset_id, kind, ordinal, original_url, caption,
  sha256, captured_at, rights_status, risk_flags_json, created_at, created_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source_revision_key, asset_id) DO NOTHING`;

const INSERT_PROVENANCE_SQL = `INSERT INTO asset_provenance (
  id, asset_id, kind, origin, source_url, source_revision_id, request_id, created_at
) VALUES (?, ?, 'imported', 'source_media', ?, ?, ?, ?)
ON CONFLICT (id) DO NOTHING`;

/**
 * 将候选冻结为 preserved：同事务（调用方包裹）写入 Binding（确定性 id `sbm:<candidateId>`）、
 * 独立 imported Provenance 行（同字节跨 Source 复用 Asset 时各 Source 保留独立血缘）并置候选终态。
 * 幂等：同 candidate 重放只补缺失行，不覆盖既有 Binding/Provenance。
 * 失败 Candidate 不得调用本函数（不创建假 Asset/Binding）。
 */
export function completeMediaCandidatePreserved(
  database: DatabaseSync,
  input: PreserveMediaCandidateInput
): SourceMediaBindingRecord {
  const before = getMediaCandidate(database, input.candidateId);
  if (!before) throw new Error(`候选不存在: ${input.candidateId}`);
  if (before.status !== 'downloading' && before.status !== 'pending') {
    if (before.status === 'preserved') {
      // 幂等重放：返回既有 Binding。
      const existing = database
        .prepare('SELECT id FROM source_media_bindings WHERE candidate_id = ?')
        .get(input.candidateId) as { id: string } | undefined;
      if (existing) return getSourceMediaBindingById(database, existing.id)!;
    }
    throw new Error(`候选状态不允许冻结为 preserved: ${before.status}`);
  }
  const now = input.archivedAt ?? new Date().toISOString();
  const bindingId = `sbm:${input.candidateId}`;
  const rightsStatus: MediaRightsStatus = input.rightsStatus ?? 'unknown';
  const riskFlags = input.riskFlags ?? [];
  const bindingResult = database
    .prepare(INSERT_BINDING_SQL)
    .run(
      bindingId,
      input.sourceId,
      input.sourceRevisionKey,
      input.candidateId,
      input.assetId,
      input.kind,
      input.ordinal,
      input.originalUrl,
      input.caption ?? null,
      input.sha256,
      input.capturedAt,
      rightsStatus,
      JSON.stringify(riskFlags),
      now,
      input.createdBy
    );
  if (bindingResult.changes > 0) {
    // 同字节跨 Source 复用 Asset：每个 preserved 候选独立 imported Provenance（血缘可逆）。
    database
      .prepare(INSERT_PROVENANCE_SQL)
      .run(`smp:${input.candidateId}`, input.assetId, input.originalUrl, input.sourceRevisionKey, input.requestId ?? null, now);
  } else {
    // UNIQUE(source_revision_key, asset_id) 冲突：同 revision 同字节已被其他候选绑定 →
    // 复用既有 Binding（设计：同字节跨候选共享 Binding），但候选仍须置 preserved
    // （preserved 的定义 = 同事务存在对应 Binding 行；幂等重放不覆盖）。
    const existing = database
      .prepare('SELECT id FROM source_media_bindings WHERE source_revision_key = ? AND asset_id = ? ORDER BY id LIMIT 1')
      .get(input.sourceRevisionKey, input.assetId) as { id: string } | undefined;
    if (existing) {
      database
        .prepare(`UPDATE source_media_candidates SET status = 'preserved', archived_at = ?, error_code = NULL, error_message = NULL, retry_after = NULL WHERE id = ?`)
        .run(now, input.candidateId);
      return getSourceMediaBindingById(database, existing.id)!;
    }
  }
  database
    .prepare(`UPDATE source_media_candidates SET status = 'preserved', archived_at = ?, error_code = NULL, error_message = NULL, retry_after = NULL WHERE id = ?`)
    .run(now, input.candidateId);
  const binding = getSourceMediaBindingById(database, bindingId);
  if (!binding) {
    // 兜底（竞争窗口）：按 (revKey, assetId) 再查一次既有 Binding。
    const existing = database
      .prepare('SELECT id FROM source_media_bindings WHERE source_revision_key = ? AND asset_id = ? ORDER BY id LIMIT 1')
      .get(input.sourceRevisionKey, input.assetId) as { id: string } | undefined;
    if (existing) return getSourceMediaBindingById(database, existing.id)!;
    throw new Error(`preserved 候选 Binding 写入后读取失败: ${bindingId}`);
  }
  return binding;
}

/** 归档 Binding（M4 GC/删除门使用；原件 Asset 字节永不删除）。 */
export function archiveSourceMediaBinding(
  database: DatabaseSync,
  bindingId: string,
  archivedReason: string,
  archivedAt = new Date().toISOString()
): SourceMediaBindingRecord {
  database
    .prepare('UPDATE source_media_bindings SET archived_at = ?, archived_reason = ? WHERE id = ?')
    .run(archivedAt, archivedReason, bindingId);
  return getSourceMediaBindingById(database, bindingId)!;
}

/**
 * 更新 Binding 权利状态（设计 §13：AI 不能把 unknown/restricted 改成已授权）。
 * restricted → 其他状态需要显式用户确认（requireUserConfirmation）并写操作证据；否则抛错。
 */
export function setBindingRightsStatus(
  database: DatabaseSync,
  bindingId: string,
  rightsStatus: MediaRightsStatus,
  options: { requireUserConfirmation?: boolean } = {}
): SourceMediaBindingRecord {
  const binding = getSourceMediaBindingById(database, bindingId);
  if (!binding) throw new Error(`绑定不存在: ${bindingId}`);
  if (binding.rightsStatus === 'restricted' && rightsStatus !== 'restricted' && !options.requireUserConfirmation) {
    throw new Error('RESTRICTED_BINDING_NEEDS_USER_CONFIRMATION');
  }
  database.prepare('UPDATE source_media_bindings SET rights_status = ? WHERE id = ?').run(rightsStatus, bindingId);
  return getSourceMediaBindingById(database, bindingId)!;
}

// ---------------------------------------------------------------------------
// 只读模型（紧凑原语；渠道接线 / worker / 读模型消费）
// ---------------------------------------------------------------------------

export function getMediaCandidate(database: DatabaseSync, candidateId: string): MediaCandidateRecord | null {
  const row = database.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM source_media_candidates WHERE id = ?`).get(candidateId);
  return row ? mapCandidateRow(row as Record<string, unknown>) : null;
}

/** 某 Source revision 的候选（稳定序：ordinal, id）。 */
export function listMediaCandidatesForRevision(
  database: DatabaseSync,
  sourceRevisionKeyValue: string
): MediaCandidateRecord[] {
  const rows = database
    .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM source_media_candidates WHERE source_revision_key = ? ORDER BY ordinal, id`)
    .all(sourceRevisionKeyValue) as Array<Record<string, unknown>>;
  return rows.map(mapCandidateRow);
}

/** UI 计数口径（设计 §8）：当前 revision 候选总数与 preserved 数。 */
export type MediaArchiveStatusSummary = Readonly<{
  total: number;
  preserved: number;
  pending: number;
  downloading: number;
  failed: number;
  unsupported: number;
  needsUser: number;
  skippedLimit: number;
}>;

export function mediaArchiveStatusSummary(database: DatabaseSync, sourceRevisionKeyValue: string): MediaArchiveStatusSummary {
  const rows = database
    .prepare('SELECT status, COUNT(*) AS count FROM source_media_candidates WHERE source_revision_key = ? GROUP BY status')
    .all(sourceRevisionKeyValue) as Array<{ status: MediaCandidateStatus; count: number }>;
  const summary = {
    total: 0,
    preserved: 0,
    pending: 0,
    downloading: 0,
    failed: 0,
    unsupported: 0,
    needsUser: 0,
    skippedLimit: 0
  };
  for (const row of rows) {
    summary.total += Number(row.count);
    switch (row.status) {
      case 'preserved': summary.preserved += Number(row.count); break;
      case 'pending': summary.pending += Number(row.count); break;
      case 'downloading': summary.downloading += Number(row.count); break;
      case 'failed': summary.failed += Number(row.count); break;
      case 'unsupported': summary.unsupported += Number(row.count); break;
      case 'needs_user': summary.needsUser += Number(row.count); break;
      case 'skipped_limit': summary.skippedLimit += Number(row.count); break;
    }
  }
  return summary;
}

const ATTEMPT_COLUMNS = `candidate_id AS candidateId, attempt, status, error_code AS errorCode, error_message AS errorMessage,
  started_at AS startedAt, finished_at AS finishedAt, runtime_name AS runtimeName, runtime_version AS runtimeVersion,
  parameter_hash AS parameterHash`;

function mapAttemptRow(row: Record<string, unknown>): MediaArchiveAttemptRecord {
  return {
    // 迁移 64 使用复合主键 (candidate_id, attempt)，无独立 id 列；记录 id 派生供既有调用方使用。
    id: `${String(row.candidateId)}:${String(row.attempt)}`,
    candidateId: String(row.candidateId),
    attempt: Number(row.attempt),
    status: row.status as MediaArchiveAttemptStatus,
    errorCode: (row.errorCode as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    startedAt: String(row.startedAt),
    finishedAt: (row.finishedAt as string | null) ?? null,
    runtimeName: (row.runtimeName as string | null) ?? null,
    runtimeVersion: (row.runtimeVersion as string | null) ?? null,
    parameterHash: (row.parameterHash as string | null) ?? null
  };
}

export function getArchiveAttempt(database: DatabaseSync, candidateId: string, attempt: number): MediaArchiveAttemptRecord | null {
  const row = database
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM media_archive_attempts WHERE candidate_id = ? AND attempt = ?`)
    .get(candidateId, attempt);
  return row ? mapAttemptRow(row as Record<string, unknown>) : null;
}

/** 候选的全部尝试（按 attempt 升序；含 Source 事务预建的初始行）。 */
export function listArchiveAttempts(database: DatabaseSync, candidateId: string): MediaArchiveAttemptRecord[] {
  const rows = database
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM media_archive_attempts WHERE candidate_id = ? ORDER BY attempt`)
    .all(candidateId) as Array<Record<string, unknown>>;
  return rows.map(mapAttemptRow);
}

const BINDING_COLUMNS = `id, source_id AS sourceId, source_revision_key AS sourceRevisionKey, candidate_id AS candidateId,
  asset_id AS assetId, kind, ordinal, original_url AS originalUrl, caption, sha256, captured_at AS capturedAt,
  rights_status AS rightsStatus, risk_flags_json AS riskFlagsJson, created_at AS createdAt, created_by AS createdBy,
  archived_at AS archivedAt, archived_reason AS archivedReason`;

function mapBindingRow(row: Record<string, unknown>): SourceMediaBindingRecord {
  return {
    id: String(row.id),
    sourceId: String(row.sourceId),
    sourceRevisionKey: String(row.sourceRevisionKey),
    candidateId: String(row.candidateId),
    assetId: String(row.assetId),
    kind: row.kind as MediaCandidateKind,
    ordinal: Number(row.ordinal),
    originalUrl: String(row.originalUrl),
    caption: (row.caption as string | null) ?? null,
    sha256: String(row.sha256),
    capturedAt: String(row.capturedAt),
    rightsStatus: row.rightsStatus as MediaRightsStatus,
    riskFlagsJson: String(row.riskFlagsJson),
    createdAt: String(row.createdAt),
    createdBy: String(row.createdBy),
    archivedAt: (row.archivedAt as string | null) ?? null,
    archivedReason: (row.archivedReason as string | null) ?? null
  };
}

export function getSourceMediaBindingById(database: DatabaseSync, bindingId: string): SourceMediaBindingRecord | null {
  const row = database.prepare(`SELECT ${BINDING_COLUMNS} FROM source_media_bindings WHERE id = ?`).get(bindingId);
  return row ? mapBindingRow(row as Record<string, unknown>) : null;
}

export function listSourceMediaBindings(database: DatabaseSync, sourceRevisionKeyValue: string): SourceMediaBindingRecord[] {
  const rows = database
    .prepare(`SELECT ${BINDING_COLUMNS} FROM source_media_bindings WHERE source_revision_key = ? ORDER BY ordinal, kind, id`)
    .all(sourceRevisionKeyValue) as Array<Record<string, unknown>>;
  return rows.map(mapBindingRow);
}
