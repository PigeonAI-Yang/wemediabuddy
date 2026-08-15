// WMB-5244 §7.4 / §8：sources.upsert_batch 保存路径的媒体候选接线（Research/记者保存）。
//
// 职责（只做保存路径；迁移 DDL 归 MediaSchema，存储原语归 ArchiveWorker）：
// - validateMediaCandidates：纯函数校验可选结构化 mediaCandidates（http(s) 身份、拒绝
//   file:/wmb-asset:/本地路径、有界形状）；非法输入在写 Source 前抛错（fail before writes）。
// - deriveCandidateChannel：研究写回（无 feedId）⇒ research；带 feedId 的记者保存按 feed 归属推导。
// - persistSourceMediaCandidates：调用方事务内（dispatcher BEGIN IMMEDIATE，transaction:false）
//   委托 media-archive-store.insertMediaCandidates —— 候选行 + 首个 Attempt + media_archive Job
//   与 Source 保存同事务原子落库；提交后由 ArchiveWorker 异步归档。
// - scheduleSourceMediaDiscovery：无结构化候选时调度有界重发现
//   （kind='media_discover'，dedupe_key 由 shared/media-candidates.mediaDiscoverDedupeKey 保证，
//   INSERT OR IGNORE ⇒ 每 source revision 至多一行；抓取失败不影响已保存 Source）。
//
// 不变式：
// - 候选不携带 feedId（研究写回无 feed 身份；channel 服务端推导）。
// - 候选行不含字节；preserved 的唯一定义是 ArchiveWorker 同事务写入 source_media_bindings。
// - 本模块不做下载、不建 Asset、不注册权限命令；下载/SSRF/限额执行在 ArchiveWorker。
// - 数据模型与身份函数以 src/shared/media-candidates.ts 为唯一权威（禁止第二套同名类型）。

import type { DatabaseSync } from 'node:sqlite';
import {
  MEDIA_LIMITS_DEFAULT
} from '../shared/media-limits.ts';
import {
  MEDIA_ARCHIVE_JOB_KIND,
  MEDIA_DISCOVER_JOB_KIND,
  mediaDiscoverDedupeKey,
  type MediaCandidateKind,
  type MediaChannel,
  type MediaPostKind
} from '../shared/media-candidates.ts';
import {
  insertMediaCandidates,
  stableRemoteIdentity,
  enqueueMediaDiscoverJob,
  type MediaCandidateInput
} from './db/media-archive-store.ts';

// ============================================================
// 公开线形状（wmb_save_source / sources.upsert_batch 可选结构化媒体候选）
// ============================================================

/** 一个远程媒体槽位（服务端重新验证 URL/scheme/限额；拒绝本地路径、file:、wmb-asset:）。 */
export type SaveSourceMediaCandidate = Readonly<{
  kind: MediaCandidateKind;
  /** 必须为 http(s) URL。 */
  url: string;
  postKind?: MediaPostKind;
  /** video_poster 必须指向同批 video 候选；其他 kind 可选引用同批候选。 */
  parentUrl?: string;
  /** 0..255 的槽位序号；缺省按数组下标。同批 (ordinal, kind) 不得重复。 */
  ordinal?: number;
  captionHint?: string;
  surroundingText?: string;
}>;

/** 本保存路径的文本/URL 长度上限（下载字节/时长限额在 ArchiveWorker 按 MEDIA_LIMITS_DEFAULT 执行）。 */
export const SAVE_MEDIA_TEXT_LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxCaptionHintLength: 500,
  maxSurroundingTextLength: 2000,
  maxOrdinal: 255
} as const);

const POST_KINDS: Readonly<Record<string, true>> = Object.freeze({
  tweet: true,
  repost: true,
  quote: true,
  web: true
});
const CANDIDATE_KINDS: Readonly<Record<MediaCandidateKind, true>> = Object.freeze({
  image: true,
  video: true,
  video_poster: true
});

function isCandidateKind(value: unknown): value is MediaCandidateKind {
  return typeof value === 'string' && value in CANDIDATE_KINDS;
}

export class MediaCandidatesInvalidError extends Error {
  readonly code = 'MEDIA_CANDIDATES_INVALID' as const;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'MediaCandidatesInvalidError';
    this.details = details;
  }
}

// ============================================================
// 服务端校验（fail before writes；MCP zod 边界镜像同规则）
// ============================================================

function assertRemoteHttpUrl(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MediaCandidatesInvalidError(`${what} 必须是非空 URL。`);
  }
  const value = raw.trim();
  if (value.length > SAVE_MEDIA_TEXT_LIMITS.maxUrlLength) {
    throw new MediaCandidatesInvalidError(`${what} 超长（>${SAVE_MEDIA_TEXT_LIMITS.maxUrlLength}）。`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MediaCandidatesInvalidError(`${what} 不是合法 URL。`, { url: value });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // 拒绝 file: / wmb-asset: / data: / blob: / ftp: / javascript: 等本地或内部身份。
    throw new MediaCandidatesInvalidError(`${what} 只允许 http(s) 远程 URL，拒绝本地/内部身份。`, {
      url: value,
      protocol: parsed.protocol
    });
  }
  if (!parsed.hostname) {
    throw new MediaCandidatesInvalidError(`${what} 缺少主机名。`, { url: value });
  }
  return value;
}

/**
 * 校验候选批次的有界形状并返回规范化输入：
 * - kind/postKind 枚举、ordinal 0..255、captionHint/surroundingText 长度上限；
 * - 计数上限（MEDIA_LIMITS_DEFAULT）：image+video_poster ≤ 20、video ≤ 4、总数 ≤ 24；
 * - 同批同 stable identity 去重（保留首个）；同批 (ordinal, kind) 不得重复；
 * - video_poster 必须带 parentUrl 且指向同批 video 候选；其他 kind 的 parentUrl 必须指向同批候选。
 * 任一违反 ⇒ 抛 MediaCandidatesInvalidError，调用方（dispatcher 事务内）零写入回滚。
 */
export function validateMediaCandidates(raw: unknown): SaveSourceMediaCandidate[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new MediaCandidatesInvalidError('mediaCandidates 必须是数组。');
  }
  const maxTotal = MEDIA_LIMITS_DEFAULT.maxImagesPerRevision + MEDIA_LIMITS_DEFAULT.maxVideosPerRevision;
  if (raw.length > maxTotal) {
    throw new MediaCandidatesInvalidError(`媒体候选总数超限（>${maxTotal}）。`, { count: raw.length });
  }
  const validated: SaveSourceMediaCandidate[] = [];
  const identitySet = new Set<string>();
  const ordinalKindSet = new Set<string>();
  let videoCount = 0;
  let imageCount = 0;
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选必须是对象。`);
    }
    const item = entry as Record<string, unknown>;
    const kind = item.kind;
    if (!isCandidateKind(kind)) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 kind 非法（image|video|video_poster）。`, { kind });
    }
    const url = assertRemoteHttpUrl(item.url, `第 ${index} 个媒体候选 url`);
    const identity = stableRemoteIdentity(url);
    if (identitySet.has(identity)) continue; // 同批同 URL 去重（保留首个）
    identitySet.add(identity);
    if (kind === 'video') {
      videoCount += 1;
      if (videoCount > MEDIA_LIMITS_DEFAULT.maxVideosPerRevision) {
        throw new MediaCandidatesInvalidError(`视频候选超限（>${MEDIA_LIMITS_DEFAULT.maxVideosPerRevision}）。`, { videoCount });
      }
    } else {
      imageCount += 1;
      if (imageCount > MEDIA_LIMITS_DEFAULT.maxImagesPerRevision) {
        throw new MediaCandidatesInvalidError(`图片候选超限（>${MEDIA_LIMITS_DEFAULT.maxImagesPerRevision}）。`, { imageCount });
      }
    }
    const postKind = item.postKind;
    if (postKind !== undefined && (typeof postKind !== 'string' || !POST_KINDS[postKind])) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 postKind 非法（tweet|repost|quote|web）。`, { postKind });
    }
    const ordinal = item.ordinal;
    if (ordinal !== undefined && (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > SAVE_MEDIA_TEXT_LIMITS.maxOrdinal)) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 ordinal 必须为 0..${SAVE_MEDIA_TEXT_LIMITS.maxOrdinal} 整数。`, { ordinal });
    }
    const resolvedOrdinal = ordinal as number | undefined;
    const captionHint = item.captionHint;
    if (captionHint !== undefined && (typeof captionHint !== 'string' || captionHint.length > SAVE_MEDIA_TEXT_LIMITS.maxCaptionHintLength)) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 captionHint 超长（>${SAVE_MEDIA_TEXT_LIMITS.maxCaptionHintLength}）。`);
    }
    const surroundingText = item.surroundingText;
    if (surroundingText !== undefined && (typeof surroundingText !== 'string' || surroundingText.length > SAVE_MEDIA_TEXT_LIMITS.maxSurroundingTextLength)) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 surroundingText 超长（>${SAVE_MEDIA_TEXT_LIMITS.maxSurroundingTextLength}）。`);
    }
    const parentUrl = item.parentUrl === undefined || item.parentUrl === null
      ? undefined
      : assertRemoteHttpUrl(item.parentUrl, `第 ${index} 个媒体候选 parentUrl`);
    if (kind === 'video_poster' && !parentUrl) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 video_poster 必须携带指向同批视频的 parentUrl。`);
    }
    const ordinalKey = `${resolvedOrdinal ?? index}:${kind}`;
    if (ordinalKindSet.has(ordinalKey)) {
      throw new MediaCandidatesInvalidError(`第 ${index} 个媒体候选 (ordinal, kind) 与同批已有候选重复。`, { ordinal: resolvedOrdinal ?? index, kind });
    }
    ordinalKindSet.add(ordinalKey);
    validated.push({
      kind,
      url,
      ...(postKind !== undefined ? { postKind: postKind as MediaPostKind } : {}),
      ...(parentUrl !== undefined ? { parentUrl } : {}),
      ...(resolvedOrdinal !== undefined ? { ordinal: resolvedOrdinal } : {}),
      ...(captionHint !== undefined ? { captionHint: captionHint as string } : {}),
      ...(surroundingText !== undefined ? { surroundingText: surroundingText as string } : {})
    });
  }
  // 父引用必须指向同批已保留候选；video_poster 的父必须是 video。
  const byIdentity = new Map<string, SaveSourceMediaCandidate>();
  for (const candidate of validated) byIdentity.set(stableRemoteIdentity(candidate.url), candidate);
  for (const candidate of validated) {
    if (!candidate.parentUrl) continue;
    const parent = byIdentity.get(stableRemoteIdentity(candidate.parentUrl));
    if (!parent) {
      throw new MediaCandidatesInvalidError('parentUrl 必须指向同批媒体候选。', { url: candidate.url, parentUrl: candidate.parentUrl });
    }
    if (candidate.kind === 'video_poster' && parent.kind !== 'video') {
      throw new MediaCandidatesInvalidError('video_poster 的 parentUrl 必须指向同批 video 候选。', { url: candidate.url, parentUrl: candidate.parentUrl });
    }
  }
  return validated;
}

// ============================================================
// 渠道推导（研究写回无 feedId ⇒ research；带 feedId 的记者保存按 feed 归属）
// ============================================================

export function deriveCandidateChannel(
  database: DatabaseSync,
  item: Readonly<{ clientLabel?: string; feedId?: string }>
): MediaChannel {
  if (item.clientLabel === 'WMB research') return 'research';
  if (item.feedId) {
    const row = database.prepare(
      `SELECT module FROM (
         SELECT 'official_web' AS module FROM website_sources WHERE source_feed_id = ?
         UNION ALL
         SELECT 'x_lists' AS module FROM x_list_bindings WHERE source_feed_id = ?
       ) LIMIT 1`
    ).get(item.feedId, item.feedId) as { module: string } | undefined;
    if (row?.module === 'official_web') return 'official_web';
    if (row?.module === 'x_lists') return 'x_lists';
  }
  return 'research';
}

// ============================================================
// 同事务持久化（transaction:false —— 调用方持有 dispatcher 事务，与 Source 同提交）
// ============================================================

export type SourceMediaPersistResult = Readonly<{
  candidateIds: readonly string[];
  inserted: readonly string[];
  reused: readonly string[];
}>;

/**
 * 委托 media-archive-store.insertMediaCandidates：候选行 + 初始 Attempt（attempt=1 running）+
 * media_archive jobs 行（dedupe_key = media:<sourceRevisionKey>:<candidateId>，payload 仅含
 * workspaceId/sourceId/sourceRevisionKey/candidateId），与 Source 保存同事务原子落库。
 * 幂等：同 revision 重放 → 复用既有 candidate，不重复写 Attempt/Job。
 */
export function persistSourceMediaCandidates(
  database: DatabaseSync,
  input: {
    sourceId: string;
    sourceRevisionKey: string;
    channel: MediaChannel;
    candidates: readonly SaveSourceMediaCandidate[];
    requestId: string;
    now?: string;
  }
): SourceMediaPersistResult {
  if (input.candidates.length === 0) return { candidateIds: [], inserted: [], reused: [] };
  // 同批 URL → ordinal 映射（父引用解析；ordinal 缺省为数组下标，与 store 的确定性 id 一致）。
  const ordinalByIdentity = new Map<string, number>();
  for (const [index, candidate] of input.candidates.entries()) {
    ordinalByIdentity.set(stableRemoteIdentity(candidate.url), candidate.ordinal ?? index);
  }
  const descriptors: MediaCandidateInput[] = input.candidates.map((candidate, index) => ({
    kind: candidate.kind,
    originalUrl: candidate.url,
    channel: input.channel,
    postKind: candidate.postKind ?? null,
    parentOrdinal: candidate.parentUrl
      ? (ordinalByIdentity.get(stableRemoteIdentity(candidate.parentUrl)) ?? null)
      : null,
    postOrdinal: 0,
    ordinalInPost: candidate.ordinal ?? index,
    ordinal: candidate.ordinal ?? index,
    captionHint: candidate.captionHint ?? null,
    surroundingText: candidate.surroundingText ?? null,
    maxAttempts: MEDIA_LIMITS_DEFAULT.maxAttempts
  }));
  const result = insertMediaCandidates(database, {
    sourceId: input.sourceId,
    sourceRevisionKey: input.sourceRevisionKey,
    channel: input.channel,
    requestId: input.requestId,
    discoveredAt: input.now ?? new Date().toISOString(),
    candidates: descriptors
  });
  return { candidateIds: result.candidateIds, inserted: result.inserted, reused: result.reused };
}

export type SourceMediaDiscoveryResult = Readonly<{
  scheduled: boolean;
}>;

/**
 * 无结构化候选时调度有界重发现：kind='media_discover'，dedupe_key =
 * media_discover:<sourceRevisionKey>（shared 常量），INSERT OR IGNORE ⇒ 每 source revision
 * 至多一个发现 job（重放/重复保存幂等）。payload 仅含 workspaceId/sourceId/sourceRevisionKey/
 * originalUrl；抓取失败由 worker 侧记录，不影响已保存 Source。
 */
export function scheduleSourceMediaDiscovery(
  database: DatabaseSync,
  input: {
    sourceId: string;
    sourceRevisionKey: string;
    originalUrl: string;
    now?: string;
  }
): SourceMediaDiscoveryResult {
  const dedupeKey = mediaDiscoverDedupeKey(input.sourceRevisionKey);
  const before = database.prepare(
    `SELECT 1 FROM jobs WHERE kind = ? AND dedupe_key = ?`
  ).get(MEDIA_DISCOVER_JOB_KIND, dedupeKey) as { '1': number } | undefined;
  enqueueMediaDiscoverJob(database, {
    workspaceId: '',
    sourceId: input.sourceId,
    sourceRevisionKey: input.sourceRevisionKey,
    originalUrl: input.originalUrl
  });
  // enqueueMediaDiscoverJob 幂等（INSERT OR IGNORE）：同 revision 已有发现 job 则 scheduled=false。
  const scheduled = before === undefined;
  return { scheduled };
}

// Re-export 便于调用方/测试引用固定 job kind（来源仍为 shared 唯一权威）。
export { MEDIA_ARCHIVE_JOB_KIND, MEDIA_DISCOVER_JOB_KIND };
