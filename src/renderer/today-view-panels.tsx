import { useState } from 'react';
import type { SourceBodyCacheRecord } from '../main/source-body-cache';
import type { TodaySource } from '../main/workbench';
import { SourceMark } from './source-mark';
import { CreateIconButton, MAX_SELECTED_SOURCES, domainOf, formatSourcePublishedAt, isHeartbeatSource, priorityGrade, priorityLabel, sourceOriginLabel, type SelectedTodaySource } from './today-view-parts';
import {
  isPreservedMediaItem,
  sourceMediaGroupLabel,
  sourceMediaKindLabel,
  sourceMediaProgress,
  sourceMediaStatusLabel,
  type SourceMediaItem,
  type SourceMediaOverview,
  type SourceMediaStatusGroup
} from '../shared/source-media';

type Fermenting = NonNullable<NonNullable<Awaited<ReturnType<typeof window.wmb.getToday>>>['fermenting']>;
type FermentingItem = Fermenting['items'][number];

function initialFermentingOpen(): boolean {
  // 仅首屏默认展开；之后完全由用户点击决定（不可每帧写死 open=true）。
  return typeof window !== 'undefined' ? window.matchMedia('(min-height: 900px)').matches : false;
}

export function FermentingRail({ fermenting, createFromCarry, selectedId = null, onSelectItem }: {
  fermenting: Fermenting;
  createFromCarry: (item: FermentingItem) => Promise<void>;
  selectedId?: string | null;
  onSelectItem?: (item: FermentingItem | null) => void;
}): React.JSX.Element | null {
  // M-5001: prefer topic-progress rows; fall back only if backend still emits legacy rows.
  const topicItems = (fermenting.topics ?? []).map((topic) => ({
    id: `topic:${topic.topicId}`,
    objectType: 'topic' as const,
    objectId: topic.topicId,
    title: topic.title,
    priority: null as number | null,
    reason: topic.latestTitle ? `最新进展：${topic.latestTitle}` : '主题持续关注',
    fermentedDays: topic.fermentedDays,
    aftershocks: topic.latestTitle ? [{ sourceId: '', title: topic.latestTitle, collectedAt: '' }] : []
  }));
  const projected = (fermenting.items ?? []).filter((item) => item.objectType === 'topic');
  const items = (projected.length ? projected : topicItems) as FermentingItem[];
  const watchingCount = fermenting.watchingItems?.length ?? 0;
  const [open, setOpen] = useState(initialFermentingOpen);
  const onToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };
  if (!items.length && !watchingCount) {
    return <details className="fermenting-rail light" aria-label="持续关注" open={open} onToggle={onToggle}>
      <summary className="fermenting-head"><h2>持续关注 · 主题 · 0</h2></summary>
      <p className="empty-copy">没有需要持续关注的主题。</p>
    </details>;
  }
  return <details className="fermenting-rail light" aria-label="持续关注" open={open} onToggle={onToggle}>
    <summary className="fermenting-head">
      <h2>持续关注 · 主题 · {items.length}</h2>
      {watchingCount > 0 ? <span className="fermenting-watching-count">观察中 · {watchingCount}</span> : null}
    </summary>
    <div className="fermenting-list">
      {items.map((item) => {
        const why = item.aftershocks?.[0]?.title
          ? `最新进展：${item.aftershocks[0].title}`
          : (item.reason || '主题持续关注');
        const latest = item.aftershocks?.[0];
        const canCreate = item.objectType === 'topic' || item.objectType === 'plan_item';
        return <article
          className={`fermenting-row${selectedId === item.id ? ' selected' : ''}`}
          key={item.id}
          title={selectedId === item.id ? '再次点击取消 Pi 焦点' : '点击设为 Pi 焦点'}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) return;
            onSelectItem?.(selectedId === item.id ? null : item);
          }}
        >
          <div className="fermenting-row-main">
            <strong className="opp-grade" data-grade={priorityGrade(item.priority)}>{item.objectType === 'topic' ? '主题' : priorityLabel(item.priority)}</strong>
            <div className="fermenting-row-text">
              <h3>{item.title}</h3>
              <div className="fermenting-row-meta">
                <span>为何关注：{why}</span>
                <span>已关注 {item.fermentedDays} 天</span>
                <span>最新进展：{latest ? latest.title : '暂无新进展'}</span>
              </div>
            </div>
          </div>
          <div className="fermenting-actions">
            {canCreate ? <CreateIconButton onClick={() => void createFromCarry(item)}/> : null}
          </div>
        </article>;
      })}
    </div>
  </details>;
}

function assetUrl(assetId: string): string {
  return `wmb-asset://${encodeURIComponent(assetId)}`;
}

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

/** 缩略图文件角标：优先真实 mime，未知时按候选类型兜底（绝不对远程 URL 声称已保存）。 */
function mediaFileTag(item: SourceMediaItem): string {
  const mime = item.asset?.mimeType?.toLowerCase() ?? '';
  if (mime.includes('video')) return 'MP4';
  if (mime.includes('png')) return 'PNG';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'JPG';
  if (item.kind === 'video') return '视频';
  if (item.kind === 'video_poster') return '封面';
  return '图';
}

/** 状态分布 chip 色（仅用既有 token；失败/待人工共用琥珀警示）。 */
function mediaChipClass(group: SourceMediaStatusGroup): string {
  switch (group) {
    case 'preserved': return 'ok';
    case 'processing': return 'accent';
    case 'failed':
    case 'needs_user': return 'amber';
    default: return '';
  }
}

/** 存档媒体证据：计数 + 全状态分布 + preserved 单选预览（wmb-asset://），远程 URL 绝不呈现为已保存。 */
function TodaySourceMedia({ overview, loading, error }: {
  overview: SourceMediaOverview | null;
  loading: boolean;
  error: string;
}): React.JSX.Element {
  const items = overview?.items ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = items[Math.min(selectedIndex, Math.max(0, items.length - 1))] ?? null;
  const counts = overview?.counts;
  const hasMedia = Boolean(counts && counts.total > 0);
  const allSaved = Boolean(counts && counts.total > 0 && counts.preserved >= counts.total);
  const completeText = counts ? `已保存 ${sourceMediaProgress(counts)}` : '';
  const groupChips: Array<{ group: SourceMediaStatusGroup; count: number }> = counts ? ([
    { group: 'preserved', count: counts.preserved },
    { group: 'processing', count: counts.processing },
    { group: 'failed', count: counts.failed },
    { group: 'needs_user', count: counts.needsUser },
    { group: 'skipped', count: counts.skippedLimit },
    { group: 'unsupported', count: counts.unsupported }
  ] satisfies Array<{ group: SourceMediaStatusGroup; count: number }>).filter((entry) => entry.count > 0) : [];
  const selectedSaved = selected != null && isPreservedMediaItem(selected);
  const selectedLabel = selected
    ? `${sourceMediaKindLabel(selected.kind)} ${selected.ordinal + 1}（${sourceMediaStatusLabel(selected.status)}）`
    : '媒体预览';
  let preview: React.JSX.Element;
  if (!selected) {
    preview = <p className="media-preview-empty">暂无媒体可预览。</p>;
  } else if (selectedSaved && selected.kind === 'video' && selected.asset) {
    preview = <video className="media-preview-video" controls preload="metadata" src={assetUrl(selected.asset.id)} aria-label={selectedLabel} />;
  } else if (selectedSaved && selected.asset) {
    preview = <img className="media-preview-img" src={assetUrl(selected.asset.id)} alt={selectedLabel} loading="lazy" />;
  } else {
    preview = <p className="media-preview-empty">该媒体{sourceMediaStatusLabel(selected.status)}，尚未本地保存，暂无法预览。</p>;
  }
  const captionMeta = selectedSaved && selected.asset
    ? [sourceMediaKindLabel(selected.kind), formatBytes(selected.asset.byteCount), formatDuration(selected.asset.durationMs)].filter(Boolean).join(' · ')
    : selected ? sourceMediaStatusLabel(selected.status) : '';
  return <>
    <div className="media-head">
      <h2 className="section-label" id="source-media-heading">存档媒体证据{overview ? ` · ${overview.counts.total} 项` : ''}</h2>
      {hasMedia && counts ? <span className={`chip${allSaved ? ' ok' : ''}`}><span className="dot" />{completeText}</span> : null}
    </div>
    {loading && !overview ? <p className="empty-copy">正在读取媒体…</p> : null}
    {!loading && !overview && error ? <p className="source-detail-error">{error}</p> : null}
    {overview && !hasMedia ? <p className="empty-copy">这条资料没有随附媒体</p> : null}
    {hasMedia && counts ? <>
      {!allSaved ? <div className="media-chips" role="list" aria-label="媒体状态分布">
        {groupChips.map((entry) => (
          <span className={`chip ${mediaChipClass(entry.group)}`} role="listitem" key={entry.group}>
            <span className="dot" />{sourceMediaGroupLabel(entry.group)} {entry.count}
          </span>
        ))}
      </div> : null}
      <div className="media-preview">{preview}</div>
      <div className="media-caption">
        <strong>{selected ? selected.captionHint || selectedLabel : '媒体预览'}</strong>
        <span>{captionMeta}</span>
        {selectedSaved ? <span className="grow" /> : null}
        {selectedSaved ? <span className="chip ok"><span className="dot" />已本地保存</span> : null}
      </div>
      <div className="media-thumbs" role="group" aria-label="选择要查看的存档媒体">
        {items.map((item, index) => {
          const saved = isPreservedMediaItem(item);
          return <button
            type="button"
            key={item.id}
            className={`media-thumb${index === selectedIndex ? ' selected' : ''}`}
            aria-pressed={index === selectedIndex}
            aria-label={`${sourceMediaKindLabel(item.kind)} ${item.ordinal + 1}（${sourceMediaStatusLabel(item.status)}）`}
            onClick={() => setSelectedIndex(index)}
          >
            {saved && item.kind !== 'video' && item.asset ? <img src={assetUrl(item.asset.id)} alt="" loading="lazy" /> : null}
            {item.kind === 'video' && saved && item.asset ? <span className="thumb-video" aria-hidden="true" /> : null}
            <span className="thumb-tag">{mediaFileTag(item)}</span>
            <span className={`thumb-status${saved ? ' ok' : ''}`}><span className="dot" />{saved ? '已保存' : sourceMediaStatusLabel(item.status)}</span>
          </button>;
        })}
      </div>
    </> : null}
  </>;
}

function normalizeSourceContent(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? '';
}

function sourceContentEquivalent(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeSourceContent(left);
  const normalizedRight = normalizeSourceContent(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const [shorter, longer] = normalizedLeft.length <= normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  return shorter.length >= 80 && longer.startsWith(shorter) && shorter.length / longer.length >= 0.65;
}

function isSocialPostUrl(value: string | null | undefined): boolean {
  const host = domainOf(value ?? null)?.toLocaleLowerCase() ?? '';
  return host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com');
}

/** WMB-5271：按单一阅读顺序呈现资料，不使用漂浮侧卡或正文/Pi 耦合动作。 */
export function TodaySourceDetail({ onBack, openLibrary, aiSourcePresentation, detailSource, detailBody, detailBodyLoading, detailBodyError, detailMedia, detailMediaLoading, detailMediaError }: {
  onBack: () => void;
  openLibrary: (sourceId?: string) => void;
  aiSourcePresentation: boolean;
  detailSource: TodaySource;
  detailBody: SourceBodyCacheRecord | null;
  detailBodyLoading: boolean;
  detailBodyError: string;
  detailMedia: SourceMediaOverview | null;
  detailMediaLoading: boolean;
  detailMediaError: string;
}): React.JSX.Element {
  const bodyReady = detailBody?.status === 'ready';
  const publishedText = formatSourcePublishedAt(detailSource.publishedAt);
  const collectedText = formatSourcePublishedAt(detailSource.collectedAt);
  const identitySub = [
    domainOf(detailSource.canonicalUrl),
    publishedText ? `${publishedText} 发布` : collectedText ? `${collectedText} 入库` : null
  ].filter(Boolean).join(' · ') || '来源信息未知';
  const titleText = detailSource.title.trim();
  const summaryText = detailSource.summary?.trim() ?? '';
  const archivedText = bodyReady ? detailBody.extractedText?.trim() ?? '' : '';
  const comparableSocialTexts = [titleText, summaryText, archivedText].filter(Boolean);
  const longestSocialText = comparableSocialTexts.reduce((longest, current) => current.length > longest.length ? current : longest, '');
  const useUnifiedSocialCopy = isSocialPostUrl(detailSource.canonicalUrl)
    && comparableSocialTexts.length >= 2
    && comparableSocialTexts.every((value) => sourceContentEquivalent(value, longestSocialText));
  const primaryText = useUnifiedSocialCopy ? longestSocialText : titleText;
  const showSummary = !summaryText || !sourceContentEquivalent(summaryText, primaryText);
  const archivedDuplicatesVisibleCopy = Boolean(archivedText && (
    sourceContentEquivalent(archivedText, primaryText)
    || (showSummary && sourceContentEquivalent(archivedText, summaryText))
  ));
  const showBodySection = !(bodyReady && archivedText && archivedDuplicatesVisibleCopy);

  return <section className="today-main today-source-detail-page" data-testid="today-source-detail-page">
    <article className="today-source-detail" data-source-detail>
      <header className="detail-head">
        <div className="detail-head-row">
          <button type="button" className="text-button today-source-detail-back" onClick={onBack}>← 返回今日</button>
          <div className="today-source-detail-actions" aria-label="来源操作">
            <button type="button" className="secondary-button" onClick={() => openLibrary(detailSource.id)}>在资料库中查看</button>
            {detailSource.canonicalUrl ? <button type="button" className="secondary-button" onClick={() => void window.wmb.openExternal(detailSource.canonicalUrl!)}>打开原文 ↗</button> : null}
          </div>
        </div>
        <div className="detail-intro">
          <div className="source-id">
            <SourceMark canonicalUrl={detailSource.canonicalUrl} aiSourcePresentation={aiSourcePresentation} avatarUrl={detailSource.avatarUrl}/>
            <span className="source-name">
              <strong>{detailSource.author?.trim() || sourceOriginLabel(detailSource)}</strong>
              <span>{identitySub}</span>
            </span>
            {isHeartbeatSource(detailSource) ? <span className="chip amber"><span className="dot" />巡检打卡</span> : null}
          </div>
          <div className="detail-primary-copy">
            <h1 className="detail-title">{primaryText}</h1>
            {archivedDuplicatesVisibleCopy ? <span className="body-archive-state ok source-body-inline-state">正文已归档 · {detailBody?.extractedChars ?? archivedText.length} 字</span> : null}
          </div>
        </div>
      </header>

      {showSummary ? <section className="detail-section detail-summary" aria-labelledby="source-summary-heading">
        <h2 className="section-label" id="source-summary-heading">工作摘要</h2>
        <p className="section-copy">{summaryText || '这条资料还没有可用摘要。可打开原文确认。'}</p>
      </section> : null}

      <section className="detail-section detail-media" aria-labelledby="source-media-heading">
        <TodaySourceMedia key={detailSource.id} overview={detailMedia} loading={detailMediaLoading} error={detailMediaError}/>
      </section>

      {showBodySection ? <section className="detail-section detail-body" aria-labelledby="source-body-heading">
        <div className="body-heading-row">
          <h2 className="section-label" id="source-body-heading">正文摘录</h2>
          {bodyReady ? <span className="body-archive-state ok">已归档 · {detailBody.extractedChars} 字</span> : null}
        </div>
        {detailBodyLoading ? <p className="body-placeholder">正在读取已归档正文…</p> : null}
        {!detailBodyLoading && detailBodyError ? <div className="body-archive-message error"><strong>正文状态暂不可用</strong><p>{detailBodyError}</p></div> : null}
        {!detailBodyLoading && detailBody?.status === 'failed' ? <div className="body-archive-message error">
          <strong>正文未能归档</strong>
          <p>{detailBody.errorMessage || '可前往资料库查看采集异常并重试。'}</p>
        </div> : null}
        {!detailBodyLoading && detailBody?.status === 'empty' ? <div className="body-archive-message"><strong>原文没有可归档正文</strong><p>摘要与原始链接仍可用于研判。</p></div> : null}
        {!detailBodyLoading && !detailBody ? <div className="body-archive-message"><strong>正文正在后台归档</strong><p>完成后会自动出现在这里，不需要手动抓取。</p></div> : null}
        {bodyReady && detailBody.extractedText ? <div className="excerpt-box" tabIndex={0} role="region" aria-label="正文摘录内容"><p>{detailBody.extractedText.slice(0, 6000)}</p></div> : null}
      </section> : null}

      <footer className="source-provenance" aria-label="来源与版权提示">
        <div className="source-provenance-copy">
          <strong>来源与版权</strong>
          <p>内容版权归原作者{detailSource.author ? ` ${detailSource.author}` : ''}及所属平台所有。本资料仅用于内部编辑研判，对外引用或商用前需确认授权。</p>
        </div>
        {detailSource.canonicalUrl ? <p className="canon-url"><span className="url-label">原文</span>{detailSource.canonicalUrl}</p> : null}
      </footer>
    </article>
  </section>;
}
