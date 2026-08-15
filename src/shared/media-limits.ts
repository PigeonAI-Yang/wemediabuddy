// WMB-5244：情报媒体资产化首版限额（设计 §8 实施合同，M1 集中常量）。
// 纯常量模块，无 Node 依赖；main / preload / renderer 均可导入。
// 设置页 M4 只读展示本常量；M1 不提供任意调大。修改默认值必须同步设计文档与验收矩阵。

export type MediaLimits = Readonly<{
  /** 单图片最大字节（20 MiB）。 */
  imageMaxBytes: number;
  /** 单视频最大字节（500 MiB）。 */
  videoMaxBytes: number;
  /** 单视频最大时长（30 分钟，毫秒）。 */
  videoMaxDurationMs: number;
  /** 每 Source revision 最多图片候选。 */
  maxImagesPerRevision: number;
  /** 每 Source revision 最多视频候选。 */
  maxVideosPerRevision: number;
  /** 每 Source revision 媒体总量上限（1 GiB）。 */
  maxTotalBytesPerRevision: number;
  /** 全局下载并发。 */
  downloadConcurrency: number;
  /** 连接/首字节超时（毫秒）。 */
  connectTimeoutMs: number;
  /** 重定向最多跳数。 */
  maxRedirects: number;
  /** 每候选最多自动 attempt。 */
  maxAttempts: number;
  /** 每 Source revision 自动图片理解上限。 */
  maxImageUnderstandingPerRevision: number;
  /** 每 Source revision 自动视频理解上限。 */
  maxVideoUnderstandingPerRevision: number;
  /** 单视频最多关键帧。 */
  maxKeyframesPerVideo: number;
  /** 单视频最多 Segment。 */
  maxSegmentsPerVideo: number;
  /** 用户物化 Clip 最长时长（毫秒）。 */
  clipMaxDurationMs: number;
  /** 每平台版本每原视频最多 Clip 数。 */
  maxClipsPerVideoPerPlatformVersion: number;
  /** 无引用派生缓存保留天数。 */
  derivedCacheRetentionDays: number;
  /** 候选发现排除：声明宽或高小于该像素值的媒体。 */
  minMediaDimensionPx: number;
}>;

/** 首版默认值即实施合同；任何调整须经设计变更。 */
export const MEDIA_LIMITS_DEFAULT: MediaLimits = Object.freeze({
  imageMaxBytes: 20 * 1024 * 1024,
  videoMaxBytes: 500 * 1024 * 1024,
  videoMaxDurationMs: 30 * 60 * 1000,
  maxImagesPerRevision: 20,
  maxVideosPerRevision: 4,
  maxTotalBytesPerRevision: 1024 * 1024 * 1024,
  downloadConcurrency: 3,
  connectTimeoutMs: 30_000,
  maxRedirects: 5,
  maxAttempts: 3,
  maxImageUnderstandingPerRevision: 12,
  maxVideoUnderstandingPerRevision: 4,
  maxKeyframesPerVideo: 48,
  maxSegmentsPerVideo: 64,
  clipMaxDurationMs: 60_000,
  maxClipsPerVideoPerPlatformVersion: 3,
  derivedCacheRetentionDays: 30,
  minMediaDimensionPx: 64
});
