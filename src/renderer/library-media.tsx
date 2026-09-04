// WMB-5244: 资料库 Source 详情的「媒体」区块。
// - 只读投影 + 用户动作（重试单项 / 全局暂停 / 查看本地原件）；不做任何写库，动作走 window.wmb IPC。
// - 真源口径（src/shared/source-media.ts）：preserved = 候选状态 preserved 且本地绑定存在；
//   远程 URL 候选绝不以「已保存」呈现；完整度显示「媒体 3/5 已保存」。
// - 无新颜色：状态 pill 复用既有 token（success/info/danger/amber/muted）。
import {
  isPreservedMediaItem,
  sourceMediaGroupLabel,
  sourceMediaKindLabel,
  sourceMediaProgress,
  sourceMediaStatusGroup,
  sourceMediaStatusLabel,
  type SourceMediaItem,
  type SourceMediaOverview
} from '../shared/source-media';

export type SourceMediaBusy =
  | { action: 'retry' | 'open'; candidateId: string }
  | { action: 'pause' }
  | null;

export type SourceMediaSectionProps = Readonly<{
  overview: SourceMediaOverview | null;
  loading: boolean;
  busy: SourceMediaBusy;
  onRetry: (candidateId: string) => void;
  onTogglePause: (paused: boolean) => void;
  onOpenOriginal: (candidateId: string) => void;
}>;

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function originDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** 状态 pill 色（既有 token，无新颜色）：已保存/处理中/失败/待人工/超限·不支持。 */
function statusClass(item: SourceMediaItem): string {
  const group = sourceMediaStatusGroup(item.status);
  switch (group) {
    case 'preserved':
      return 'green';
    case 'processing':
      return 'blue';
    case 'failed':
      return 'red';
    case 'needs_user':
      return 'amber';
    case 'skipped':
    case 'unsupported':
      return 'gray';
    default:
      return 'gray';
  }
}

function groupCounts(overview: SourceMediaOverview): Array<{ group: string; count: number }> {
  const counts = overview.counts;
  return [
    { group: 'preserved', count: counts.preserved },
    { group: 'processing', count: counts.processing },
    { group: 'failed', count: counts.failed },
    { group: 'needs_user', count: counts.needsUser },
    { group: 'skipped', count: counts.skippedLimit },
    { group: 'unsupported', count: counts.unsupported }
  ].filter((entry) => entry.count > 0);
}

function kindTotal(overview: SourceMediaOverview, kind: string): number {
  return overview.items.filter((item) => item.kind === kind).length;
}

/** 可重试：仅失败候选（worker 命令 media_archive.retry_candidate 只接受 failed）。 */
function canRetry(item: SourceMediaItem): boolean {
  return sourceMediaStatusGroup(item.status) === 'failed';
}

export function SourceMediaSection(props: SourceMediaSectionProps) {
  const { overview, loading, busy, onRetry, onTogglePause, onOpenOriginal } = props;
  if (loading && !overview) {
    return (
      <section className="library-source-media" aria-label="媒体">
        <h2>媒体</h2>
        <p className="library-detail-loading">正在读取媒体…</p>
      </section>
    );
  }
  if (!overview) {
    return (
      <section className="library-source-media" aria-label="媒体">
        <h2>媒体</h2>
        <p className="empty-copy">暂时无法读取媒体状态。</p>
      </section>
    );
  }
  const counts = overview.counts;
  const hasMedia = counts.total > 0;
  const completeText = counts.preserved >= counts.total
    ? '媒体已全部保存'
    : `媒体 ${sourceMediaProgress(counts)} 已保存`;
  const kindText = [
    kindTotal(overview, 'image') > 0 ? `图片 ${kindTotal(overview, 'image')}` : null,
    kindTotal(overview, 'video') > 0 ? `视频 ${kindTotal(overview, 'video')}` : null,
    kindTotal(overview, 'video_poster') > 0 ? `封面 ${kindTotal(overview, 'video_poster')}` : null
  ].filter(Boolean).join(' · ');
  const chips = groupCounts(overview);
  const pauseBusy = busy?.action === 'pause';
  const preservedItems = overview.items.filter(isPreservedMediaItem);
  const preservedVideoOrdinals = new Set(preservedItems.filter((item) => item.kind === 'video').map((item) => item.ordinal));
  const visiblePreservedItems = preservedItems.filter((item) => item.kind !== 'video_poster' || !preservedVideoOrdinals.has(item.ordinal));
  const posterByOrdinal = new Map<number, string>();
  for (const item of preservedItems) {
    if (item.kind === 'video_poster' && item.asset) posterByOrdinal.set(item.ordinal, item.asset.id);
  }

  return (
    <section className="library-source-media" aria-label="媒体">
      <div className="library-source-media-head">
        <h2>媒体</h2>
        {visiblePreservedItems.length ? <span>{visiblePreservedItems.length} 项可直接查看</span> : null}
      </div>
      {!hasMedia ? (
        <>
          <p className="empty-copy">此资料暂无可保存的图片或视频。</p>
          <button
            type="button"
            className="text-button library-media-pause"
            aria-pressed={overview.globalPaused}
            disabled={pauseBusy}
            onClick={() => onTogglePause(!overview.globalPaused)}
          >{overview.globalPaused ? '恢复媒体自动保存' : '暂停媒体自动保存'}</button>
        </>
      ) : (
        <>
          {visiblePreservedItems.length ? (
            <div className={`library-media-viewer count-${Math.min(visiblePreservedItems.length, 4)}`} role="list" aria-label="已保存媒体">
              {visiblePreservedItems.map((item) => {
                const label = item.captionHint || `${sourceMediaKindLabel(item.kind)} ${item.ordinal + 1}`;
                const openBusy = busy?.action === 'open' && busy.candidateId === item.id;
                const meta = item.asset ? [formatBytes(item.asset.byteCount), item.kind === 'video' ? formatDuration(item.asset.durationMs) : '', originDomain(item.originalUrl)].filter(Boolean).join(' · ') : originDomain(item.originalUrl);
                const posterAssetId = posterByOrdinal.get(item.ordinal);
                return <figure className={`library-media-figure kind-${item.kind}`} role="listitem" key={item.id}>
                  <div className="library-media-content">
                    {item.kind === 'video' && item.asset ? (
                      <video
                        className="library-media-video"
                        src={`wmb-asset://${encodeURIComponent(item.asset.id)}`}
                        poster={posterAssetId ? `wmb-asset://${encodeURIComponent(posterAssetId)}` : undefined}
                        controls
                        playsInline
                        preload="metadata"
                        aria-label={label}
                      />
                    ) : item.asset ? (
                      <img className="library-media-image" src={`wmb-asset://${encodeURIComponent(item.asset.id)}`} alt={label} loading="lazy" />
                    ) : null}
                  </div>
                  <figcaption>
                    <span><strong>{label}</strong><small>{meta}</small></span>
                    <button type="button" className="text-button" disabled={openBusy} onClick={() => onOpenOriginal(item.id)}>打开原件</button>
                  </figcaption>
                </figure>;
              })}
            </div>
          ) : <p className="library-media-preview-empty">媒体正在保存或需要处理，完成后会直接显示在这里。</p>}

          <details className="library-media-management" open={visiblePreservedItems.length === 0}>
            <summary><span>媒体保存状态</span><small>{completeText}{kindText ? ` · ${kindText}` : ''}</small></summary>
            <div className="library-media-management-content">
              <div className="library-media-management-head">
                <p className="library-source-media-summary">
                  <strong>{completeText}</strong>
                  {overview.globalPaused ? <em>媒体自动保存已暂停</em> : null}
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  aria-pressed={overview.globalPaused}
                  disabled={pauseBusy}
                  onClick={() => onTogglePause(!overview.globalPaused)}
                >{overview.globalPaused ? '恢复自动保存' : '暂停自动保存'}</button>
              </div>
              {chips.length ? (
                <div className="library-media-chips" role="list" aria-label="媒体状态分布">
                  {chips.map((entry) => (
                    <span className={`tag lib-inline ${entry.group === 'preserved' ? 'green' : entry.group === 'processing' ? 'blue' : entry.group === 'failed' ? 'red' : entry.group === 'needs_user' ? 'amber' : 'gray'}`} role="listitem" key={entry.group}>
                      {sourceMediaGroupLabel(entry.group)} {entry.count}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="library-media-list" role="list" aria-label={`媒体列表，${completeText}`}>
                {overview.items.map((item) => {
                  const preserved = isPreservedMediaItem(item);
                  const group = sourceMediaStatusGroup(item.status);
                  const orderText = `${sourceMediaKindLabel(item.kind)} ${item.ordinal + 1}`;
                  const sizeText = preserved && item.asset ? formatBytes(item.asset.byteCount) : '';
                  const durationText = item.kind === 'video' ? formatDuration(item.asset?.durationMs) : '';
                  const retryBusy = busy?.action === 'retry' && busy.candidateId === item.id;
                  return (
                    <article className="library-media-item" role="listitem" key={item.id}>
                      <div className="library-media-main">
                        <div className="library-media-item-head">
                          <span className="library-media-order">{orderText}</span>
                          <span className={`pill-status ${statusClass(item)}`}><span className="dot" />{sourceMediaStatusLabel(item.status)}</span>
                        </div>
                        <p className="library-media-origin" title={item.originalUrl}>{originDomain(item.originalUrl)}</p>
                        {item.captionHint ? <p className="library-media-caption">{item.captionHint}</p> : null}
                        {sizeText || durationText ? <p className="library-media-size">{[sizeText, durationText].filter(Boolean).join(' · ')}</p> : null}
                        {item.errorMessage && (group === 'failed' || group === 'needs_user' || group === 'unsupported') ? (
                          <p className="library-media-error">{item.errorMessage}</p>
                        ) : null}
                      </div>
                      <div className="library-media-actions">
                        {canRetry(item) ? (
                          <button type="button" className="secondary-button" disabled={retryBusy} aria-label={`重试${orderText}`} onClick={() => onRetry(item.id)}>重试</button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
