import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayPlanItem } from '../main/workbench';
import type { ProposalLedgerItem, ProposalLedgerResult, ProposalTab } from '../main/proposals';
import { appConfirm } from './app-confirm';
import { toggleSingleFocus } from './pi-focus';
import { Opportunity } from './today-view-parts';
import { poolBadges, poolItemToPlanItem, type PoolItemLike } from './today-pool-view';

type LedgerItem = ProposalLedgerItem;

const PAGE_SIZE = 30;

const TABS: Array<{ id: ProposalTab; label: string }> = [
  { id: 'today', label: '今日可批' },
  { id: 'shelved', label: '待处理' },
  { id: 'adopted', label: '已采纳' },
  { id: 'dismissed', label: '已否掉' },
  { id: 'expired', label: '已过期' }
];

const STATE_LABELS: Record<Exclude<ProposalTab, 'today' | 'shelved'>, string> = {
  adopted: '已采纳',
  dismissed: '已否掉',
  expired: '已过期'
};

const EMPTY_COUNTS = { today: 0, shelved: 0, adopted: 0, dismissed: 0, expired: 0 };

function ledgerItemToPoolItem(item: LedgerItem): PoolItemLike {
  return {
    planItemId: item.planItemId,
    planDate: item.planDate,
    title: item.title,
    priority: item.priority,
    timeliness: item.timeliness,
    timelinessClass: item.timelinessClass,
    expiresAt: item.expiresAt,
    topicId: item.topicId,
    sourceIds: item.sourceIds,
    whyNow: item.whyNow,
    angle: item.angle,
    pointOfView: item.pointOfView,
    targetAudience: item.targetAudience,
    platforms: item.platforms,
    formats: item.formats,
    titleGuidance: item.titleGuidance,
    openingGuidance: item.openingGuidance,
    structureGuidance: item.structureGuidance,
    effortEstimate: item.effortEstimate,
    availableMaterials: item.availableMaterials,
    missingMaterials: item.missingMaterials,
    trendEvidence: item.trendEvidence,
    createdAt: item.createdAt,
    isNew: item.isNew,
    demotion: null
  };
}

function toPlanItem(item: LedgerItem): TodayPlanItem {
  return poolItemToPlanItem(ledgerItemToPoolItem(item));
}

/** 选题台账：全量决策记录 + P1 分页 / 恢复 / 批量 / Pi 焦点。 */
export function ProposalsView({ planDate, openStudio, openTopic, onOpenProject, openToday, selectedItem = null, onSelectedItemChange }: {
  planDate: string;
  openStudio: (projectId?: string) => void;
  openTopic?: (topicId: string) => void;
  onOpenProject: (projectId: string) => void;
  openToday?: () => void;
  selectedItem?: TodayPlanItem | null;
  onSelectedItemChange?: (item: TodayPlanItem | null) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<ProposalTab>('today');
  const [data, setData] = useState<ProposalLedgerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const load = useCallback(async (nextTab: ProposalTab, nextOffset: number, append: boolean) => {
    setLoading(true);
    setError('');
    try {
      const page = await window.wmb.getProposalLedger({ planDate, tab: nextTab, limit: PAGE_SIZE, offset: nextOffset });
      if (!page) {
        setData(null);
        return;
      }
      setData((prev) => {
        if (!append || !prev || prev.tab !== nextTab) return page;
        const seen = new Set(prev.items.map((item) => item.planItemId));
        const merged = [...prev.items];
        for (const item of page.items) {
          if (!seen.has(item.planItemId)) merged.push(item);
        }
        return { ...page, items: merged };
      });
      setOffset(nextOffset);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [planDate]);

  useEffect(() => {
    setCheckedIds([]);
    setOffset(0);
    void load(tab, 0, false);
  }, [load, tab]);

  useEffect(() => {
    const unsubscribe = window.wmb.onDataChanged((event) => {
      if (event.scopes.includes('proposals') || event.scopes.includes('today') || event.scopes.includes('studio')) {
        void load(tabRef.current, 0, false);
        setCheckedIds([]);
      }
    });
    return unsubscribe;
  }, [load]);

  const counts = data?.counts ?? EMPTY_COUNTS;
  const items = data?.items ?? [];
  const openTab = tab === 'today' || tab === 'shelved';
  const hasMore = data?.hasMore === true;
  const total = data?.total ?? 0;

  const create = async (item: TodayPlanItem) => {
    const project = await window.wmb.createProjectFromPlanItem(item.id);
    if (project?.id) onOpenProject(project.id);
    else openStudio();
  };

  const dismiss = async (planItemId: string) => {
    if (!await appConfirm({ title: '否掉选题', message: '否掉这个选题？可在「已否掉」中恢复。', confirmLabel: '否掉', danger: true })) return;
    try {
      await window.wmb.dismissPlanItem({ planItemId });
      setCheckedIds((ids) => ids.filter((id) => id !== planItemId));
      if (selectedItem?.id === planItemId) onSelectedItemChange?.(null);
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : String(dismissError));
    }
  };

  const restoreOne = async (planItemId: string) => {
    try {
      await window.wmb.restoreProposal({ planItemId });
      setCheckedIds((ids) => ids.filter((id) => id !== planItemId));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : String(restoreError));
    }
  };

  const toggleChecked = (planItemId: string) => {
    setCheckedIds((ids) => ids.includes(planItemId) ? ids.filter((id) => id !== planItemId) : [...ids, planItemId]);
  };

  const batchDismiss = async () => {
    if (!checkedIds.length) return;
    if (!await appConfirm({ title: '批量否掉', message: `否掉选中的 ${checkedIds.length} 条选题？可在「已否掉」中恢复。`, confirmLabel: '全部否掉', danger: true })) return;
    setBatchBusy(true);
    setError('');
    try {
      for (const planItemId of checkedIds) {
        await window.wmb.dismissPlanItem({ planItemId });
      }
      setCheckedIds([]);
      if (selectedItem && checkedIds.includes(selectedItem.id)) onSelectedItemChange?.(null);
      await load(tab, 0, false);
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : String(batchError));
    } finally {
      setBatchBusy(false);
    }
  };

  const batchRestore = async () => {
    if (!checkedIds.length) return;
    if (!await appConfirm({ title: '批量恢复', message: `恢复选中的 ${checkedIds.length} 条选题到可处理状态？`, confirmLabel: '全部恢复' })) return;
    setBatchBusy(true);
    setError('');
    try {
      for (const planItemId of checkedIds) {
        await window.wmb.restoreProposal({ planItemId });
      }
      setCheckedIds([]);
      await load(tab, 0, false);
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : String(batchError));
    } finally {
      setBatchBusy(false);
    }
  };

  const emptyCopy: Record<ProposalTab, { title: string; body: string; action?: { label: string; onClick: () => void } }> = {
    today: { title: '今日没有待批选题', body: '所有选题都已处理。去「发现」看看今天有什么新动静。', action: openToday ? { label: '回到今日', onClick: openToday } : undefined },
    shelved: { title: '没有待处理选题', body: '跨日未终结的选题会留在这里，不会悄悄消失。' },
    adopted: { title: '还没有已采纳选题', body: '从「今日可批」采纳第一条选题后，会记录在这里。' },
    dismissed: { title: '还没有否掉的选题', body: '否掉的选题会留痕在这里，可恢复。' },
    expired: { title: '还没有过期选题', body: '超过时效窗仍未处理的选题会出现在这里。' }
  };

  const focusPlanItem = (item: LedgerItem) => {
    onSelectedItemChange?.(toggleSingleFocus(selectedItem, toPlanItem(item)));
  };

  return <section className="page library-page proposals-page">
    <section className="page-command" aria-label="选题台账概览">
      <div className="page-command-main">
        <div className="page-command-copy">
          <div className="page-command-title-row">
            <h1>选题台账</h1>
            <p>全量决策记录：今日可批、待处理、已采纳、已否掉与已过期。</p>
          </div>
          <div className="page-command-stats" aria-label="台账计数">
            <div className="page-command-stat"><strong>{counts.today ?? 0}</strong><span>今日可批</span></div>
            <div className="page-command-stat"><strong>{counts.shelved ?? 0}</strong><span>待处理</span></div>
            <div className="page-command-stat"><strong>{counts.adopted ?? 0}</strong><span>已采纳</span></div>
            <div className="page-command-stat"><strong>{counts.dismissed ?? 0}</strong><span>已否掉</span></div>
            <div className="page-command-stat"><strong>{counts.expired ?? 0}</strong><span>已过期</span></div>
          </div>
        </div>
      </div>
    </section>
    <nav className="proposal-tabs" aria-label="选题台账分类">
      {TABS.map((entry) => (
        <button key={entry.id} type="button" className={`proposal-tab${tab === entry.id ? ' active' : ''}`} onClick={() => setTab(entry.id)}>
          {entry.label}
          <span className="proposal-tab-count">{counts[entry.id]}</span>
        </button>
      ))}
    </nav>

    {checkedIds.length > 0 && (openTab || tab === 'dismissed') ? (
      <div className="proposal-batch-bar" role="region" aria-label="批量操作">
        <span>已勾选 {checkedIds.length} 条</span>
        <div className="proposal-batch-actions">
          {openTab ? <button type="button" className="secondary-button" disabled={batchBusy} onClick={() => void batchDismiss()}>批量否掉</button> : null}
          {tab === 'dismissed' ? <button type="button" className="secondary-button" disabled={batchBusy} onClick={() => void batchRestore()}>批量恢复</button> : null}
          <button type="button" className="text-button" disabled={batchBusy} onClick={() => setCheckedIds([])}>清除勾选</button>
        </div>
      </div>
    ) : null}

    {error ? <section className="empty-state proposal-empty"><h2>台账操作失败</h2><p>{error}</p></section>
      : !data || (loading && items.length === 0) ? <section className="empty-state proposal-empty"><h2>正在读取选题台账…</h2></section>
      : items.length === 0 ? <section className="empty-state proposal-empty">
          <h2>{emptyCopy[tab].title}</h2>
          <p>{emptyCopy[tab].body}</p>
          {emptyCopy[tab].action ? <button type="button" onClick={emptyCopy[tab].action?.onClick}>{emptyCopy[tab].action.label}</button> : null}
        </section>
      : openTab ? <div className="proposal-list proposal-open-list" onClick={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest('[data-opportunity-card], button, a, input, select, textarea, label')) onSelectedItemChange?.(null);
        }}>{items.map((item) => {
          const poolItem = ledgerItemToPoolItem(item);
          const planItem = poolItemToPlanItem(poolItem);
          const badges = poolBadges(poolItem, Date.now(), planDate);
          const checked = checkedIds.includes(item.planItemId);
          return <div className={`proposal-open-item${checked ? ' checked' : ''}`} key={item.planItemId}>
            <label className="proposal-check" onClick={(event) => event.stopPropagation()} title="勾选以批量操作">
              <input type="checkbox" checked={checked} onChange={() => toggleChecked(item.planItemId)} aria-label={`勾选 ${item.title}`} />
            </label>
            <Opportunity
              item={planItem}
              selected={selectedItem?.id === planItem.id}
              onToggle={(next) => onSelectedItemChange?.(toggleSingleFocus(selectedItem, next))}
              onCreate={create}
              sources={[]}
              badges={badges}
              onDismiss={() => void dismiss(item.planItemId)}
              dismissLabel="否掉这个选题"
            />
            {item.topicId && openTopic ? <div className="proposal-card-extra"><button type="button" className="proposal-topic-link" onClick={() => openTopic(item.topicId!)}>关联主题 ›</button></div> : null}
          </div>;
        })}</div>
      : <div className="proposal-list">{items.map((item) => {
          const written = (() => {
            const ms = Date.parse(item.createdAt);
            if (!Number.isFinite(ms)) return null;
            const parts = new Intl.DateTimeFormat('zh-CN', {
              timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', hour12: false
            }).formatToParts(new Date(ms));
            const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
            if (!pick('year')) return null;
            return `写入 ${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
          })();
          const checked = checkedIds.includes(item.planItemId);
          return (
          <article
            className={`proposal-row${selectedItem?.id === item.planItemId ? ' selected' : ''}${checked ? ' checked' : ''}`}
            key={item.planItemId}
            title={selectedItem?.id === item.planItemId ? '再次点击取消 Pi 焦点' : '点击设为 Pi 焦点（不进入详情）'}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button, a, input, label')) return;
              focusPlanItem(item);
            }}
          >
            {tab === 'dismissed' ? (
              <label className="proposal-check" onClick={(event) => event.stopPropagation()} title="勾选以批量恢复">
                <input type="checkbox" checked={checked} onChange={() => toggleChecked(item.planItemId)} aria-label={`勾选 ${item.title}`} />
              </label>
            ) : null}
            <div className="proposal-row-main">
              <strong className="proposal-row-title">{item.title}</strong>
              <div className="proposal-row-meta">
                <span className="proposal-row-date">选题日 {item.planDate}</span>
                {written ? <span className="proposal-row-written" title="写入时间">{written}</span> : null}
                <span className={`pill proposal-state state-${item.state}`}>{STATE_LABELS[item.state as Exclude<ProposalTab, 'today' | 'shelved'>]}</span>
                {item.state === 'dismissed' && item.carry?.reason ? <span className="proposal-dismiss-reason" title="否掉原因">{item.carry.reason}</span> : null}
                {item.topicId && openTopic ? <button type="button" className="proposal-topic-link" onClick={() => openTopic(item.topicId!)}>主题 ›</button> : null}
              </div>
            </div>
            <div className="proposal-row-actions">
              {item.state === 'adopted' && item.adoptedProjectId ? <button type="button" className="proposal-go-studio" onClick={() => onOpenProject(item.adoptedProjectId!)}>去创作 ›</button> : null}
              {item.state === 'dismissed' ? <button type="button" className="proposal-go-studio" onClick={() => void restoreOne(item.planItemId)}>恢复</button> : null}
            </div>
          </article>
          );
        })}</div>}

    {items.length > 0 ? (
      <footer className="proposal-pager">
        <span>已显示 {items.length}{total ? ` / ${total}` : ''} 条</span>
        <div className="proposal-pager-actions">
          <button type="button" className="secondary-button" disabled={loading || offset === 0} onClick={() => void load(tab, 0, false)}>回到顶部</button>
          <button
            type="button"
            className="secondary-button"
            disabled={loading || !hasMore}
            onClick={() => void load(tab, items.length, true)}
          >{loading ? '加载中…' : hasMore ? '加载更多' : '已全部加载'}</button>
        </div>
      </footer>
    ) : null}
  </section>;
}
