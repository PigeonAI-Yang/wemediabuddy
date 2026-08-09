import { useState } from 'react';
import type { TodaySource } from '../main/workbench';
import { CreateIconButton, MAX_SELECTED_SOURCES, domainOf, formatSourcePublishedAt, isHeartbeatSource, priorityGrade, priorityLabel, type SelectedTodaySource } from './today-view-parts';

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

export function TodaySourceDetail({ detailSource, detailBody, detailBodyLoading, detailBodyError, selectedSources, onClose, onToggleSelection, onAttachBody, openLibrary }: {
  detailSource: TodaySource;
  detailBody: Awaited<ReturnType<typeof window.wmb.getSourceBodyCache>>;
  detailBodyLoading: boolean;
  detailBodyError: string;
  selectedSources: SelectedTodaySource[];
  onClose: () => void;
  onToggleSelection: (source: TodaySource) => void;
  onAttachBody: (source: TodaySource, force?: boolean) => Promise<void>;
  openLibrary: (sourceId?: string) => void;
}): React.JSX.Element {
  const toggleSourceSelection = onToggleSelection;
  const attachBodyToSelection = onAttachBody;
  return <>{detailSource && <aside className="sources-panel open source-detail-panel" data-source-detail aria-label="资料详情">
      <div className="panel-heading">
        <p className="eyebrow">{isHeartbeatSource(detailSource) ? '巡检打卡 · 摘要可能很薄' : '资料详情'}</p>
        <div>
          <h2>{detailSource.title}</h2>
          <button className="close-sources" aria-label="关闭资料详情" onClick={() => onClose()}>×</button>
        </div>
        <p>
          {(detailSource.categories[0] || '入库资料')}
          {' · '}
          {formatSourcePublishedAt(detailSource.publishedAt) ?? formatSourcePublishedAt(detailSource.collectedAt) ?? '时间未知'}
          {detailSource.author ? ` · ${detailSource.author}` : (domainOf(detailSource.canonicalUrl) ? ` · ${domainOf(detailSource.canonicalUrl)}` : '')}
        </p>
      </div>
      <div className="source-detail-body">
        <section>
          <h3>工作摘要</h3>
          <p>{detailSource.summary?.trim() || '这条资料还没有可用摘要。可抓取正文，或打开原文确认。'}</p>
        </section>
        <section>
          <div className="source-detail-body-head">
            <h3>正文缓存</h3>
            <span className="source-detail-body-status">
              {detailBodyLoading ? '处理中…'
                : detailBody?.status === 'ready' ? `已缓存 ${detailBody.extractedChars} 字`
                : detailBody?.status === 'failed' ? '抓取失败'
                : detailBody?.status === 'empty' ? '无正文'
                : '尚未抓取'}
            </span>
          </div>
          {detailBodyError ? <p className="source-detail-error">{detailBodyError}</p> : null}
          {detailBody?.errorMessage ? <p className="source-detail-error">{detailBody.errorMessage}</p> : null}
          {detailBody?.status === 'ready' && detailBody.extractedText
            ? <div className="source-detail-text">{detailBody.extractedText.slice(0, 6000)}</div>
            : <p className="empty-copy">暂无正文</p>}
        </section>
      </div>
      <div className="source-detail-actions">
        <button
          className={selectedSources.some((item) => item.id === detailSource.id) ? 'secondary-button' : 'primary-button'}
          onClick={() => toggleSourceSelection(detailSource)}
          disabled={!selectedSources.some((item) => item.id === detailSource.id) && selectedSources.length >= MAX_SELECTED_SOURCES}
        >
          {selectedSources.some((item) => item.id === detailSource.id) ? '移出 Pi 上下文' : '加入 Pi 上下文'}
        </button>
        <button className="secondary-button" disabled={detailBodyLoading} onClick={() => void attachBodyToSelection(detailSource, false)}>
          {detailBody?.status === 'ready' ? '带正文给 Pi' : '抓取正文并给 Pi'}
        </button>
        {detailBody?.status === 'ready' ? <button className="secondary-button" disabled={detailBodyLoading} onClick={() => void attachBodyToSelection(detailSource, true)}>重新抓取</button> : null}
        {detailSource.canonicalUrl ? <button className="secondary-button" onClick={() => void window.wmb.openExternal(detailSource.canonicalUrl!)}>打开原文 ↗</button> : null}
        <button className="secondary-button" onClick={() => openLibrary(detailSource.id)}>在资料库中查看</button>
      </div>
    </aside>}</>;
}
