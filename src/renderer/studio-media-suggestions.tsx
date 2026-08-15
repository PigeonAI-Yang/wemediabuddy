// WMB-5246: Studio 媒体区「来源素材建议」面板（StudioMediaWorkflow 所有）。
// 消费 MediaRecommendations 引擎的读模型（media-recommendations:* IPC，类型见
// src/shared/media-recommendations.ts）：按正文观点（claim）分组展示建议 —— 目标段落、
// 理由、图注、变换、来源/风险；动作：生成建议 / 接受 / 拒绝。
// 接受 = 独立 Studio 保存边界：本面板只记录用户决定（decide）并把媒体放入草稿
// （图片 → 正文 token；视频 → 平台结构化附件绑定），版本写入仍由保存事务完成。
// 视频播放/定位走 wmb-asset:// 本地协议（main 侧 Range 支持，见 src/main/index.ts）。

import { useMemo, useRef, useState, type ReactElement } from 'react';
import type { ContentProjectPlatform } from '../main/content';
import type { MediaRecommendation, MediaRecommendationsReadModel, MediaRecommendationState, MediaRecommendationTransform } from '../shared/media-recommendations';
import { mediaRecommendationPurposeLabel } from '../shared/media-recommendations';
import type { StudioSourceMedia } from '../main/studio-media-projection';
import { studioMediaKindLabel, studioRightsLabel, studioRiskFlagLabel } from '../shared/studio-media-labels';
import { formatAssetSize } from './studio-view-helpers';

export type StudioMediaSuggestionsProps = {
  readModel: MediaRecommendationsReadModel | null;
  sourceMedia: StudioSourceMedia[];
  activePlatform: ContentProjectPlatform | null;
  readOnlyVersion: boolean;
  busy: boolean;
  generating: boolean;
  onGenerate: () => void;
  /** 接受：记录用户决定（decide accept）+ 把媒体放入草稿（图片 token / 视频平台绑定）。 */
  onAccept: (recommendation: MediaRecommendation) => void;
  /** 拒绝：记录用户决定（decide reject），零版本写入。 */
  onReject: (recommendation: MediaRecommendation) => void;
  /** 本地视频定位播放（seek 到 timeMs）。 */
  onSeekVideo: (assetId: string, timeMs: number) => void;
};

/** 毫秒 → mm:ss（Segment/Clip 时间展示）。 */
export function formatMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 建议变换中文摘要（单一实现；transform 只建议不物化）。 */
export function transformLabel(transform: MediaRecommendationTransform): string {
  if (transform.kind === 'clip') return `截取 ${formatMs(transform.startMs)}–${formatMs(transform.endMs)}`;
  if (transform.kind === 'keyframe') return `关键帧 ${formatMs(transform.timeMs)}`;
  if (transform.kind === 'crop') return '裁剪区域';
  return '原样使用';
}

const stateLabel = (state: MediaRecommendationState): string => ({
  proposed: '待处理',
  accepted: '已接受',
  rejected: '已拒绝',
  superseded: '已过期'
})[state] ?? state;

export function StudioMediaSuggestions(props: StudioMediaSuggestionsProps): ReactElement | null {
  const { readModel, sourceMedia, activePlatform, readOnlyVersion, busy, generating, onGenerate, onAccept, onReject, onSeekVideo } = props;
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [posterByAsset, setPosterByAsset] = useState<Record<string, string>>({});

  const mediaByAsset = useMemo(() => {
    const map = new Map<string, StudioSourceMedia>();
    for (const item of sourceMedia) map.set(item.assetId, item);
    return map;
  }, [sourceMedia]);

  const claims = readModel?.claims ?? [];

  if (claims.length === 0) {
    return (
      <div className="studio-suggestions-empty" role="status">
        <div className="studio-suggestions-header">
          <h3>创作媒体建议</h3>
          {!readOnlyVersion && (
            <button type="button" className="studio-suggestions-generate" disabled={busy || generating} onClick={onGenerate}>
              {generating ? '生成中…' : '生成建议'}
            </button>
          )}
        </div>
        <p>{readModel ? '尚未生成建议：点击「生成建议」按正文观点匹配已保存媒体。' : '加载建议失败或项目尚无核心正文。'}</p>
      </div>
    );
  }

  const seekVideo = (assetId: string, timeMs: number) => {
    const video = videoRefs.current.get(assetId);
    if (video) {
      try {
        video.currentTime = timeMs / 1000;
      } catch {
        // 元数据未就绪时静默；浏览器首帧兜底。
      }
      void video.play().catch(() => {});
    }
    onSeekVideo(assetId, timeMs);
  };

  return (
    <section className="studio-suggestions" aria-label="创作媒体建议">
      <header className="studio-suggestions-header">
        <h3>创作媒体建议</h3>
        {!readOnlyVersion && (
          <button type="button" className="studio-suggestions-generate" disabled={busy || generating} onClick={onGenerate}>
            {generating ? '生成中…' : '重新生成'}
          </button>
        )}
        <span className="studio-suggestions-hint">{activePlatform ? '接受后写入平台绑定草稿（保存版本时生效）' : '接受图片后插入正文；视频请在平台页签接受'}</span>
      </header>
      <div className="studio-suggestions-list">
        {claims.map((claim) => (
          <div className="studio-suggestion-claim" key={claim.claimKey}>
            <div className="studio-suggestion-claim-head">
              <span className="studio-suggestion-claim-key">{claim.claimKey}</span>
              <span className="studio-suggestion-claim-excerpt" title={claim.claimExcerpt}>{claim.claimExcerpt || '（无正文）'}</span>
            </div>
            {claim.suggestions.map((suggestion) => {
              const media = mediaByAsset.get(suggestion.assetId);
              const isVideo = suggestion.mediaKind === 'video';
              const posterAssetId = posterByAsset[suggestion.assetId] ?? null;
              const posterUrl = posterAssetId ? `wmb-asset://${posterAssetId}` : undefined;
              const clipTransform = suggestion.transform.kind === 'clip' ? suggestion.transform : null;
              const keyframes = media?.video?.keyframes ?? [];
              const segments = media?.video?.segments ?? [];
              const proposed = suggestion.state === 'proposed';
              return (
                <article className={`studio-suggestion-card${isVideo ? ' studio-suggestion-card--video' : ''}`} key={suggestion.id}>
                  <div className="studio-suggestion-media">
                    {isVideo ? (
                      <video
                        className="studio-suggestion-video"
                        ref={(node) => { if (node) videoRefs.current.set(suggestion.assetId, node); else videoRefs.current.delete(suggestion.assetId); }}
                        src={`wmb-asset://${suggestion.assetId}`}
                        poster={posterUrl}
                        muted
                        playsInline
                        preload="metadata"
                        controls={false}
                        aria-label={`视频预览 ${suggestion.caption || suggestion.assetId}`}
                      />
                    ) : (
                      <img className="studio-suggestion-thumb" src={`wmb-asset://${suggestion.assetId}`} alt="" loading="lazy" />
                    )}
                  </div>
                  <div className="studio-suggestion-main">
                    <div className="studio-suggestion-meta">
                      <span className="studio-suggestion-kind">{studioMediaKindLabel(suggestion.mediaKind)}</span>
                      <span className="studio-suggestion-priority">{mediaRecommendationPurposeLabel(suggestion.purpose)}</span>
                      <span className="studio-suggestion-state">{stateLabel(suggestion.state)}</span>
                      {media && <span className="studio-suggestion-size">{formatAssetSize(media.asset.byteCount)}</span>}
                    </div>
                    <p className="studio-suggestion-target">目标段落：{suggestion.claimExcerpt || claim.claimExcerpt || '（无正文）'}</p>
                    <p className="studio-suggestion-rationale">{suggestion.rationale}</p>
                    {suggestion.caption && <p className="studio-suggestion-caption">建议图注：{suggestion.caption}</p>}
                    <p className="studio-suggestion-transform">建议变换：{transformLabel(suggestion.transform)}</p>
                    <p className="studio-suggestion-locator" title={suggestion.provenance}>证据：{suggestion.provenance}</p>
                    <div className="studio-suggestion-risks">
                      <span className="studio-suggestion-rights">{studioRightsLabel(suggestion.rightsStatus)}</span>
                      {suggestion.riskFlags.length > 0
                        ? suggestion.riskFlags.map((flag) => <span key={flag} className="studio-suggestion-risk">{studioRiskFlagLabel(flag)}</span>)
                        : <span className="studio-suggestion-risk studio-suggestion-risk--none">无已知风险标记</span>}
                    </div>
                    {isVideo && (
                      <div className="studio-suggestion-video-detail">
                        {keyframes.length > 0 && (
                          <div className="studio-suggestion-keyframes" aria-label="关键帧">
                            {keyframes.map((frame) => (
                              <button key={frame.assetId} type="button" className="studio-suggestion-keyframe"
                                title={`${formatMs(frame.timeMs)} · 设为封面`}
                                aria-pressed={posterAssetId === frame.assetId}
                                onClick={() => setPosterByAsset((current) => ({ ...current, [suggestion.assetId]: frame.assetId }))}>
                                <img src={`wmb-asset://${frame.assetId}`} alt={`关键帧 ${formatMs(frame.timeMs)}`} loading="lazy" />
                                <span>{formatMs(frame.timeMs)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {segments.length > 0 && (
                          <div className="studio-suggestion-segments" aria-label="可引用时间段">
                            {segments.slice(0, 8).map((item) => (
                              <button key={item.index} type="button" className="studio-suggestion-segment"
                                title={item.summary ?? `时间段 ${formatMs(item.startMs)}–${formatMs(item.endMs)}`}
                                onClick={() => seekVideo(suggestion.assetId, item.startMs)}>
                                <span className="studio-suggestion-segment-time">{formatMs(item.startMs)}–{formatMs(item.endMs)}</span>
                                <span className="studio-suggestion-segment-text">{item.summary ?? item.transcript ?? '（无文本）'}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="studio-suggestion-actions">
                    {isVideo && <button type="button" className="studio-suggestion-play" onClick={() => seekVideo(suggestion.assetId, clipTransform?.startMs ?? 0)}>播放</button>}
                    {!readOnlyVersion && proposed && (
                      <>
                        <button type="button" className="primary" disabled={busy}
                          title={isVideo && !activePlatform ? '视频为结构化附件，请在平台页签接受' : undefined}
                          onClick={() => onAccept(suggestion)}>接受</button>
                        <button type="button" className="danger" disabled={busy} onClick={() => onReject(suggestion)}>拒绝</button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
