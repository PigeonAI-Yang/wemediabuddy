// WMB-5244: Source 媒体 UI 共享契约（资料库 Source 详情的媒体读模型 + 用户动作）。
// 纯类型 + 纯函数，无 Node 依赖；main / preload / renderer / tests 共用本文件为唯一权威。
// 枚举值（状态/类型/渠道）复用 src/shared/media-candidates.ts 的权威定义，不建第二套同名枚举；
// 本文件只负责 UI 投影形状、计数口径、中文文案与 IPC 通道名。
// 数据语义以 docs/spark/2026-08-14-wmb-intelligence-media-production-pipeline-design.md §6/§8/§12.1 为准：
// - preserved 的定义是当前 revision 已存在对应 source_media_bindings 行；远程 URL 候选绝不呈现为已保存。
// - UI 计数口径固定为当前 revision 的候选总数与 preserved 数（例：「媒体 3/5 已保存」）。
import {
  MEDIA_CANDIDATE_STATUSES,
  type MediaCandidateKind,
  type MediaCandidateStatus,
  type MediaChannel
} from './media-candidates.ts';

export type SourceMediaStatus = MediaCandidateStatus;
export type SourceMediaKind = MediaCandidateKind;
export type SourceMediaChannel = MediaChannel;

/** 展示分组：UI 六态（processing 聚合 pending+downloading；skipped 聚合 skipped_limit）。 */
export type SourceMediaStatusGroup =
  | 'processing'
  | 'preserved'
  | 'failed'
  | 'needs_user'
  | 'skipped'
  | 'unsupported';

/** 已保存媒体的本地 Asset 信息（仅 preserved 候选存在；不存在 → null）。 */
export type SourceMediaAssetInfo = Readonly<{
  id: string;
  mimeType: string;
  byteCount: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}>;

/** 当前 revision 的一个媒体候选（UI 读模型行）。 */
export type SourceMediaItem = Readonly<{
  id: string;
  kind: SourceMediaKind;
  ordinal: number;
  channel: SourceMediaChannel | null;
  originalUrl: string;
  captionHint: string | null;
  status: SourceMediaStatus;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** 仅 preserved 且绑定存在时非空；远程 URL 候选永远为 null。 */
  assetId: string | null;
  asset: SourceMediaAssetInfo | null;
}>;

export type SourceMediaCounts = Readonly<{
  total: number;
  preserved: number;
  processing: number;
  failed: number;
  needsUser: number;
  skippedLimit: number;
  unsupported: number;
}>;

export type SourceMediaOverview = Readonly<{
  sourceId: string;
  /** source_items.revision（媒体集合冻结所依据的版本）。 */
  revision: number;
  /** `source:<sourceId>:r<revision>`（权威实现见 media-candidates.sourceRevisionKey）。 */
  revisionKey: string;
  counts: SourceMediaCounts;
  items: readonly SourceMediaItem[];
  /** M1 全局暂停（停止 claim 新 job），非按 Source 暂停。 */
  globalPaused: boolean;
}>;

export type SourceMediaOverviewInput = Readonly<{
  sourceId: string;
}>;

export type SourceMediaRetryInput = Readonly<{
  candidateId: string;
}>;

export type SourceMediaArchivePauseInput = Readonly<{
  paused: boolean;
}>;

export type SourceMediaOpenOriginalInput = Readonly<{
  candidateId: string;
}>;

// ===== IPC 通道（主进程注册 + preload 消费同一常量，避免第二套命名） =====

export const SOURCE_MEDIA_OVERVIEW_IPC_CHANNEL = 'source:media-overview' as const;
export const SOURCE_MEDIA_RETRY_IPC_CHANNEL = 'source:media-retry' as const;
export const SOURCE_MEDIA_ARCHIVE_PAUSE_IPC_CHANNEL = 'source:media-archive-pause' as const;
export const SOURCE_MEDIA_OPEN_ORIGINAL_IPC_CHANNEL = 'source:media-open-original' as const;

// ===== 纯分类/文案（renderer 与测试共享单一实现） =====

export const SOURCE_MEDIA_STATUSES: readonly SourceMediaStatus[] = MEDIA_CANDIDATE_STATUSES;

export const SOURCE_MEDIA_GROUPS: readonly SourceMediaStatusGroup[] = [
  'processing', 'preserved', 'failed', 'needs_user', 'skipped', 'unsupported'
];

/** 候选状态 → 展示分组：pending/downloading 归入「处理中」；skipped_limit 归入「超限」。 */
export function sourceMediaStatusGroup(status: SourceMediaStatus | string): SourceMediaStatusGroup {
  switch (status) {
    case 'pending':
    case 'downloading':
      return 'processing';
    case 'preserved':
      return 'preserved';
    case 'failed':
      return 'failed';
    case 'needs_user':
      return 'needs_user';
    case 'skipped_limit':
      return 'skipped';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'unsupported';
  }
}

/** 候选状态中文文案（用户可见，非工程术语）。 */
export function sourceMediaStatusLabel(status: SourceMediaStatus | string): string {
  switch (status) {
    case 'pending':
      return '待保存';
    case 'downloading':
      return '保存中';
    case 'preserved':
      return '已保存';
    case 'failed':
      return '失败';
    case 'needs_user':
      return '待处理';
    case 'skipped_limit':
      return '超限';
    case 'unsupported':
      return '不支持';
    default:
      return '未知';
  }
}

/** 展示分组中文文案。 */
export function sourceMediaGroupLabel(group: SourceMediaStatusGroup | string): string {
  switch (group) {
    case 'processing':
      return '处理中';
    case 'preserved':
      return '已保存';
    case 'failed':
      return '失败';
    case 'needs_user':
      return '待处理';
    case 'skipped':
      return '超限';
    case 'unsupported':
      return '不支持';
    default:
      return '未知';
  }
}

/** 媒体类型中文文案。 */
export function sourceMediaKindLabel(kind: SourceMediaKind | string): string {
  switch (kind) {
    case 'video':
      return '视频';
    case 'video_poster':
      return '视频封面';
    case 'image':
      return '图片';
    default:
      return '媒体';
  }
}

/** 渠道中文文案。 */
export function sourceMediaChannelLabel(channel: SourceMediaChannel | string | null): string {
  switch (channel) {
    case 'x_lists':
      return 'X';
    case 'official_web':
      return '官网';
    case 'research':
      return '研究';
    default:
      return '';
  }
}

/**
 * 是否为真实「已保存」媒体：候选状态 preserved 且当前 revision 存在本地绑定（assetId 非空）。
 * 远程 URL 候选、失败/超限/不支持候选一律返回 false —— UI 绝不以「已保存」呈现远程 URL。
 */
export function isPreservedMediaItem(item: Pick<SourceMediaItem, 'status' | 'assetId'>): boolean {
  return item.status === 'preserved' && typeof item.assetId === 'string' && item.assetId.length > 0;
}

/** 由候选行聚合计数（纯函数；main 读模型与 renderer 归一共用）。 */
export function buildSourceMediaCounts(items: readonly Pick<SourceMediaItem, 'status' | 'assetId'>[]): SourceMediaCounts {
  const counts: Record<'total' | 'preserved' | 'processing' | 'failed' | 'needsUser' | 'skippedLimit' | 'unsupported', number> = {
    total: items.length,
    preserved: 0,
    processing: 0,
    failed: 0,
    needsUser: 0,
    skippedLimit: 0,
    unsupported: 0
  };
  for (const item of items) {
    if (isPreservedMediaItem(item)) counts.preserved += 1;
    else if (item.status === 'pending' || item.status === 'downloading') counts.processing += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else if (item.status === 'needs_user') counts.needsUser += 1;
    else if (item.status === 'skipped_limit') counts.skippedLimit += 1;
    else counts.unsupported += 1;
  }
  return counts;
}

/** 完整度口径：`preserved/total`（如 3/5）。 */
export function sourceMediaProgress(counts: Pick<SourceMediaCounts, 'total' | 'preserved'>): string {
  return `${counts.preserved}/${counts.total}`;
}
