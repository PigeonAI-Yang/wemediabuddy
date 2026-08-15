// WMB-5244：情报媒体候选/归档共享契约（设计 §6 持久对象与身份、§7 事务边界）。
// 纯类型 + 纯函数，无 Node 依赖；main / preload / renderer 均可导入。
// 数据模型与字段名以本文件为唯一权威（渠道接线、归档 worker、理解 worker、读模型统一引用）。
// 禁止在 main / renderer 各自维护第二套同名类型或 parser。

// ---------------------------------------------------------------------------
// 枚举与类型（设计 §6.1/6.2/6.3/10.3）
// ---------------------------------------------------------------------------

export const MEDIA_CANDIDATE_KINDS = ['image', 'video', 'video_poster'] as const;
export type MediaCandidateKind = (typeof MEDIA_CANDIDATE_KINDS)[number];

export const MEDIA_CHANNELS = ['x_lists', 'official_web', 'research'] as const;
export type MediaChannel = (typeof MEDIA_CHANNELS)[number];

/** 七态归档生命周期：状态只属于 Candidate 与 Attempt。 */
export const MEDIA_CANDIDATE_STATUSES = [
  'pending',
  'downloading',
  'preserved',
  'failed',
  'unsupported',
  'needs_user',
  'skipped_limit'
] as const;
export type MediaCandidateStatus = (typeof MEDIA_CANDIDATE_STATUSES)[number];

export const MEDIA_POST_KINDS = ['tweet', 'repost', 'quote', 'web'] as const;
export type MediaPostKind = (typeof MEDIA_POST_KINDS)[number];

export const MEDIA_ARCHIVE_ATTEMPT_STATUSES = ['running', 'succeeded', 'failed', 'needs_user', 'unsupported'] as const;
export type MediaArchiveAttemptStatus = (typeof MEDIA_ARCHIVE_ATTEMPT_STATUSES)[number];

export const MEDIA_RIGHTS_STATUSES = ['unknown', 'likely_reusable', 'permission_required', 'restricted'] as const;
export type MediaRightsStatus = (typeof MEDIA_RIGHTS_STATUSES)[number];

/** 风险类型（设计 §13）；risk_flags_json 元素必须来自本集合。 */
export const MEDIA_RISK_FLAGS = ['copyright', 'portrait', 'privacy', 'brand', 'paywalled', 'third_party_repost'] as const;
export type MediaRiskFlag = (typeof MEDIA_RISK_FLAGS)[number];

/** 持久 job kind（设计 §6.4：复用现有 jobs 表，不建立第二套 job 系统）。 */
export const MEDIA_ARCHIVE_JOB_KIND = 'media_archive';
/** 无结构化候选时的统一重抓 job（设计 §7.4）。 */
export const MEDIA_DISCOVER_JOB_KIND = 'media_discover';

/** 每候选默认最大自动 attempt（设计 §8）。 */
export const MEDIA_DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// 身份与键（设计 §6.1 修订键 / §6.4 dedupe_key / §7.1）
// ---------------------------------------------------------------------------

/**
 * Source 媒体集合修订键：`source:<sourceId>:r<revision>`。
 * revision 来自 `source_items.revision`，不是 `source_body_revisions` 外键；
 * X Source 没有正文 revision 也必须可冻结媒体。
 */
export function sourceRevisionKey(sourceId: string, revision: number): string {
  return `source:${sourceId}:r${revision}`;
}

/**
 * 稳定远程身份 URL 规范化：只小写 scheme/host、移除 fragment，保留 query 原顺序。
 * 非 http(s)（如 data:/blob:/file:/wmb-asset:）原样返回（调用方据此拒绝）。
 * 仅用于稳定身份（sha256(normalizedUrl)），不用于抓取（抓取使用 original_url）。
 */
export function normalizeRemoteUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return url;
  // 小写 scheme 与 host；hostname setter 不会改写 query。
  parsed.protocol = scheme;
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = ''; // 移除 fragment
  // URL 序列化保留 query 原顺序；port 保留原样。
  return parsed.toString();
}

/** media_archive job dedupe_key：`media:<sourceRevisionKey>:<candidateId>`（设计 §6.4）。 */
export function mediaArchiveDedupeKey(sourceRevisionKeyValue: string, candidateId: string): string {
  return `media:${sourceRevisionKeyValue}:${candidateId}`;
}

/** media_discover job dedupe_key（按 Source revision 幂等；设计 §7.4）。 */
export function mediaDiscoverDedupeKey(sourceRevisionKeyValue: string): string {
  return `media_discover:${sourceRevisionKeyValue}`;
}

// ---------------------------------------------------------------------------
// 视频理解 Segment 契约（设计 §10.7；10.5 transcript source）
// ---------------------------------------------------------------------------

export const VIDEO_TRANSCRIPT_SOURCES = ['native', 'asr', 'ocr', 'none'] as const;
export type VideoTranscriptSource = (typeof VIDEO_TRANSCRIPT_SOURCES)[number];

/** 时间轴 Transcript 段（原生字幕/ASR/OCR 规范化后的最小单元；毫秒时间）。 */
export type VideoTranscriptSegment = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
  source: VideoTranscriptSource;
  confidence?: number;
}>;

/** 视频证据 locator：`asset:<assetId>|sourceRevision:<sourceRevisionKey>|timeRange:<startMs>-<endMs>`（设计 §10.8）。 */
export function videoEvidenceLocator(
  assetId: string,
  sourceRevisionKeyValue: string,
  startMs: number,
  endMs: number
): string {
  return `asset:${assetId}|sourceRevision:${sourceRevisionKeyValue}|timeRange:${startMs}-${endMs}`;
}
