import type { TodaySource } from '../main/workbench';
import { CreateIconButton, MAX_SELECTED_SOURCES, domainOf, formatSourcePublishedAt, isHeartbeatSource, priorityGrade, priorityLabel, type SelectedTodaySource } from './today-view-parts';

type Fermenting = NonNullable<NonNullable<Awaited<ReturnType<typeof window.wmb.getToday>>>['fermenting']>;
type FermentingItem = Fermenting['items'][number];

export function FermentingRail({ fermenting, createFromCarry }: {
  fermenting: Fermenting;
  createFromCarry: (item: FermentingItem) => Promise<void>;
}): React.JSX.Element | null {
  return <>{(fermenting.items?.length ?? 0) > 0 && <section className="fermenting-rail light" aria-label="仍在发酵">
            <div className="fermenting-head">
              <h2>仍在发酵 · {fermenting.items.length}</h2>
            </div>
            <div className="fermenting-list">
              {fermenting.items.map((item) => <article className="fermenting-row" key={item.id}>
                <div className="fermenting-row-main">
                  <strong className="opp-grade" data-grade={priorityGrade(item.priority)}>{priorityLabel(item.priority)}</strong>
                  <div className="fermenting-row-text">
                    <h3>{item.title}</h3>
                    <div className="fermenting-row-meta">
                      <span>{item.fermentedDays} 天</span>
                      {item.originPlanDate ? <span>{item.originPlanDate}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="fermenting-actions">
                  {item.objectType === 'plan_item' ? <CreateIconButton onClick={() => void createFromCarry(item)}/> : null}
                </div>
              </article>)}
            </div>
          </section>}</>;
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
