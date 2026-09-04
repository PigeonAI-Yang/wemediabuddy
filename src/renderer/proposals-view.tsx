import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayPlanItem } from '../main/workbench';
import type { ProposalDetail, ProposalLedgerItem, ProposalLedgerResult, ProposalTab } from '../main/proposals';
import { appConfirm } from './app-confirm';
import { toggleSingleFocus } from './pi-focus';
import { Opportunity } from './today-view-parts';
import { poolBadges, poolItemToPlanItem, type PoolItemLike } from './today-pool-view';
import { approvePlanItem, approvedProjectId, getPlanningStatus, getScoreReasons, isEligibleForToday, isScoringPendingItem, pendingReasonForItem, planningStatusLabel, rejectPlanItem } from './proposal-ledger';
type LedgerItem = ProposalLedgerItem;

const PAGE_SIZE = 30;

const TABS: Array<{ id: ProposalTab; label: string }> = [
  { id: 'today', label: '今日可批' },
  { id: 'scoring_pending', label: '待评分待修复' },
  { id: 'shelved', label: '待处理' },
  { id: 'adopted', label: '已采纳' },
  { id: 'dismissed', label: '已否掉' },
  { id: 'expired', label: '已过期' }
];

const STATE_LABELS: Record<Exclude<ProposalTab, 'today' | 'shelved' | 'scoring_pending'>, string> = {
  adopted: '已采纳',
  dismissed: '已否掉',
  expired: '已过期'
};

const EMPTY_COUNTS: Record<ProposalTab, number> = { today: 0, scoring_pending: 0, shelved: 0, adopted: 0, dismissed: 0, expired: 0 };

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
    demotion: null,
    planningStatus: item.planningStatus,
    revision: item.revision,
    planningProvenanceJson: item.planningProvenanceJson,
    scoreReasonsJson: item.scoreReasonsJson,
  };
}

function toPlanItem(item: LedgerItem): TodayPlanItem {
  return poolItemToPlanItem(ledgerItemToPoolItem(item));
}

/** 选题台账：全量决策记录 + P1 分页 / 恢复 / 批量 / Pi 焦点。 */
export function ProposalsView({ planDate, openTopic, onOpenProject, openToday, selectedItem = null, onSelectedItemChange, focusPlanItemId = null }: {
  planDate: string;
  openTopic?: (topicId: string) => void;
  onOpenProject: (projectId: string) => void;
  openToday?: () => void;
  selectedItem?: TodayPlanItem | null;
  onSelectedItemChange?: (item: TodayPlanItem | null) => void;
  focusPlanItemId?: string | null;
}): React.JSX.Element {
  const [tab, setTab] = useState<ProposalTab>('today');
  const [data, setData] = useState<ProposalLedgerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const enterBatch = useCallback(() => setBatchMode(true), []);

  const exitBatch = useCallback(() => {
    setCheckedIds([]);
    setBatchMode(false);
  }, []);

  const load = useCallback(async (nextTab: ProposalTab, nextOffset: number, append: boolean) => {
    setLoading(true);
    setError('');
    try {
      const page = await window.wmb.getProposalLedger({ planDate, tab: nextTab as Exclude<ProposalTab, 'scoring_pending'>, limit: PAGE_SIZE, offset: nextOffset });
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

  useEffect(() => {
    if (!focusPlanItemId) return;
    let active = true;
    void window.wmb.getProposalDetail(focusPlanItemId).then((next) => {
      if (!active || !next) return;
      setTab(next.item.state);
      setDetailId(focusPlanItemId);
      setDetail(next);
      onSelectedItemChange?.(toPlanItem(next.item));
      window.requestAnimationFrame(() => {
        document.querySelector(`[data-plan-item-id="${CSS.escape(focusPlanItemId)}"]`)?.scrollIntoView({ block: 'center' });
      });
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [focusPlanItemId, onSelectedItemChange]);

  useEffect(() => {
    if (!batchMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.app-confirm-root')) return;
      exitBatch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [batchMode, exitBatch]);

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const threshold = 12;
    const handle = () => setIsScrolled(el.scrollTop > threshold);
    el.addEventListener('scroll', handle, { passive: true });
    handle();
    const observer = new ResizeObserver(() => handle());
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', handle);
      observer.disconnect();
    };
  }, []);

  const counts = data?.counts ?? EMPTY_COUNTS;
  const items = data?.items ?? [];
  const openTab = tab === 'today' || tab === 'shelved' || tab === 'scoring_pending';
  const isScoringPendingTab = tab === 'scoring_pending';
  const batchSupported = (tab === 'today' || tab === 'shelved') || tab === 'dismissed';
  const total = data?.total ?? 0;
  const hasMore = data?.hasMore === true;
  const showBackToTop = items.length > 0 && isScrolled;
  const showLoadMore = items.length > 0 && hasMore;

  const openDetail = useCallback(async (planItemId: string) => {
    if (detailId === planItemId) { setDetailId(null); setDetail(null); return; }
    setDetailId(planItemId); setDetail(null); setDetailLoading(true); setError('');
    try { setDetail(await window.wmb.getProposalDetail(planItemId)); }
    catch (detailError) { setError(detailError instanceof Error ? detailError.message : String(detailError)); }
    finally { setDetailLoading(false); }
  }, [detailId]);

  useEffect(() => {
    if (tab === 'today' && items.length && !detailId && !loading) void openDetail(items[0].planItemId);
  }, [tab, items, detailId, loading, openDetail]);

  const detailPanel = (item: LedgerItem) => detailId === item.planItemId ? <section className="proposal-detail" data-testid="proposal-detail" data-plan-item-id={item.planItemId}>
    {detailLoading ? <p>正在读取完整方案…</p> : !detail ? <p className="proposal-detail-error">完整方案读取失败或已不存在。</p> : <>
      <header><h3>{detail.item.title}</h3><span>{planningStatusLabel(detail.item.planningStatus)}</span></header>
      <div className="proposal-detail-grid">
        {detail.item.whyNow ? <section><h4>为什么现在</h4><p>{detail.item.whyNow}</p></section> : null}
        {detail.item.targetAudience ? <section><h4>目标读者</h4><p>{detail.item.targetAudience}</p></section> : null}
        {detail.item.angle ? <section><h4>表达角度</h4><p>{detail.item.angle}</p></section> : null}
        {detail.item.pointOfView ? <section><h4>核心观点</h4><p>{detail.item.pointOfView}</p></section> : null}
        {detail.item.titleGuidance ? <section><h4>标题建议</h4><p>{detail.item.titleGuidance}</p></section> : null}
        {detail.item.openingGuidance ? <section><h4>开头建议</h4><p>{detail.item.openingGuidance}</p></section> : null}
        {detail.item.structureGuidance ? <section className="wide"><h4>内容结构</h4><p>{detail.item.structureGuidance}</p></section> : null}
        {detail.item.availableMaterials.length ? <section><h4>已有材料</h4><p>{detail.item.availableMaterials.join('；')}</p></section> : null}
        {detail.item.missingMaterials.length ? <section><h4>缺失材料</h4><p>{detail.item.missingMaterials.join('；')}</p></section> : null}
      </div>
      <section className="proposal-detail-section"><h4>来源证据</h4>{detail.sources.map((source) => <div className="proposal-detail-source" key={source.id}><a href={source.url} onClick={(event) => { event.preventDefault(); void window.wmb.openExternal(source.url); }}>{source.title}</a><span>{source.author ?? '未知作者'} · {source.verificationStatus} · r{source.revision}</span></div>)}</section>
      <section className="proposal-detail-section"><h4>六维评分</h4>{detail.item.planningStatus === 'ready_for_review' ? <p>资料和观点已整理，批准后系统将自动调查并进入写作。</p> : detail.score?.reasons?.length ? detail.score.reasons.map((reason) => <div className="proposal-score-reason" key={reason.criterion}><strong>{reason.criterion}</strong><span>{reason.score}/{reason.weight}</span><p>{reason.reason ?? '无理由'}</p></div>) : <p>方案仍在整理。</p>}</section>
      {detail.evidenceGaps.length ? <section className="proposal-detail-section"><h4>证据缺口</h4>{detail.evidenceGaps.map((gap, index) => <p key={`${gap.code}-${index}`}>{gap.code ?? 'UNRESOLVED'}：{gap.statement ?? '待核实'}</p>)}</section> : null}
    </>}
  </section> : null;

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    setIsScrolled(el.scrollTop > 12);
  }, [items.length, total, tab]);



  const approve = async (item: LedgerItem) => {
    setActionBusyId(item.planItemId);
    setError('');
    try {
      const result = await approvePlanItem({ planItemId: item.planItemId, expectedRevision: item.revision, reason: 'Yann 批准策划' });
      const projectId = approvedProjectId(result);
      if (projectId) onOpenProject(projectId);
      else openToday?.();
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : String(approveError));
    } finally {
      setActionBusyId(null);
    }
  };

  const reject = async (item: LedgerItem) => {
    const reason = window.prompt('填写驳回原因（必填）', '请补充证据或调整切口');
    if (!reason?.trim()) return;
    setActionBusyId(item.planItemId);
    setError('');
    try {
      await rejectPlanItem({ planItemId: item.planItemId, expectedRevision: item.revision, reason });
      await load(tabRef.current, 0, false);
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : String(rejectError));
    } finally {
      setActionBusyId(null);
    }
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
    scoring_pending: { title: '暂无待评分或待修复选题', body: '评分未完成或方案不完整的条目会显示在这里，可继续评分或重新策划。' },
    shelved: { title: '没有待处理选题', body: '跨日未终结的选题会留在这里，不会悄悄消失。' },
    adopted: { title: '还没有已采纳选题', body: '从「今日可批」采纳第一条选题后，会记录在这里。' },
    dismissed: { title: '还没有否掉的选题', body: '否掉的选题会留痕在这里，可恢复。' },
    expired: { title: '还没有过期选题', body: '超过时效窗仍未处理的选题会出现在这里。' }
  };

  const focusPlanItem = (item: LedgerItem) => {
    onSelectedItemChange?.(toggleSingleFocus(selectedItem, toPlanItem(item)));
  };

  return <section ref={pageRef} className="page library-page proposals-page">
    <section className="page-command" aria-label="选题台账概览">
      <div className="page-command-main">
        <div className="page-command-copy">
          <div className="page-command-title-row">
            <h1>选题台账</h1>
          </div>
          <div className="page-command-stats" aria-label="台账计数">
            <div className="page-command-stat"><strong>{counts.today ?? 0}</strong><span>今日可批</span></div>
            <div className="page-command-stat"><strong>{counts.scoring_pending ?? 0}</strong><span>待评分待修复</span></div>
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
      {batchSupported ? (
        <button
          type="button"
          className={`proposal-batch-toggle${batchMode ? ' active' : ''}`}
          aria-pressed={batchMode}
          onClick={batchMode ? exitBatch : enterBatch}
        >{batchMode ? '退出批量' : '批量操作'}</button>
      ) : null}
    </nav>

    {checkedIds.length > 0 && (openTab || tab === 'dismissed') ? (
      <div className="proposal-batch-bar" role="region" aria-label="批量操作">
        <span>已勾选 {checkedIds.length} 条</span>
        <div className="proposal-batch-actions">
          {openTab ? <button type="button" className="primary-button danger-button" disabled={batchBusy} onClick={() => void batchDismiss()}>批量否掉</button> : null}
          {tab === 'dismissed' ? <button type="button" className="primary-button" disabled={batchBusy} onClick={() => void batchRestore()}>批量恢复</button> : null}
          <button type="button" className="text-button" disabled={batchBusy} onClick={() => setCheckedIds([])}>清除勾选</button>
        </div>
      </div>
    ) : null}

    {error ? <section className="empty-state proposal-empty"><h2>台账操作失败</h2><p>{error}</p></section>
      : !data || (loading && items.length === 0) ? <section className="empty-state proposal-empty"><h2>正在读取选题台账…</h2></section>
      : items.length === 0 ? <section className="empty-state proposal-empty">
          <h2>{emptyCopy[tab].title}</h2>
          <p>{emptyCopy[tab].body}</p>
          {emptyCopy[tab].action ? <button type="button" className="primary-button" onClick={emptyCopy[tab].action?.onClick}>{emptyCopy[tab].action.label}</button> : null}
        </section>
      : openTab ? <div className="proposal-list proposal-open-list" onClick={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest('[data-opportunity-card], button, a, input, select, textarea, label')) onSelectedItemChange?.(null);
        }}>{items.map((item) => {
          const poolItem = ledgerItemToPoolItem(item);
          const planItem = poolItemToPlanItem(poolItem);
          const baseBadges = poolBadges(poolItem, Date.now(), planDate);
          const planningStatus = getPlanningStatus(item) ?? 'draft';
          const isPendingScoring = isScoringPendingItem(item);
          const pendingReason = item.repairReason ?? (isPendingScoring ? pendingReasonForItem(item) : null);
          const badges = isPendingScoring
            ? [...baseBadges, { kind: 'pending' as const, text: pendingReason ?? '评分未完成' }]
            : baseBadges;
          const busy = actionBusyId === item.planItemId;
          const checked = checkedIds.includes(item.planItemId);
          return <div className={`proposal-open-item${checked ? ' checked' : ''}${batchMode ? ' batch' : ''}`} key={item.planItemId}>
            {batchMode ? (
              <label className="proposal-check" onClick={(event) => event.stopPropagation()} title="勾选以批量操作">
                <input type="checkbox" checked={checked} onChange={() => toggleChecked(item.planItemId)} aria-label={`勾选 ${item.title}`} />
              </label>
            ) : null}
            <Opportunity
              item={planItem}
              selected={selectedItem?.id === planItem.id}
              onToggle={(next) => onSelectedItemChange?.(toggleSingleFocus(selectedItem, next))}
              sources={[]}
              badges={badges}
            />
            <div className="proposal-card-extra proposal-planning-actions" data-planning-status={planningStatus} data-pending-reason={pendingReason ?? undefined}>
              <div className="proposal-card-actions">
                {isScoringPendingTab || isPendingScoring ? (
                  <span className="pill pending-reason" title={pendingReason ?? '评分未完成'}>{pendingReason ?? '请分步补齐评分条件'}</span>
                ) : (
                  <>
                    <button type="button" className="proposal-action proposal-action--dismiss" aria-label="否掉这个选题" title="否掉这个选题，不再出现" disabled={busy} onClick={() => void dismiss(item.planItemId)}>否掉</button>
                    {planningStatus === 'ready_for_review' ? (
                      <div className="proposal-planning-buttons">
                        <button type="button" className="proposal-action" disabled={busy} onClick={() => void reject(item)}>驳回</button>
                        <button type="button" className="proposal-action primary-button" disabled={busy} onClick={() => void approve(item)}>批准并开始创作</button>
                      </div>
                    ) : null}
                    {planningStatus === 'approved' && item.adoptedProjectId ? (
                      <button type="button" className="proposal-action primary-button" onClick={() => onOpenProject(item.adoptedProjectId!)}>打开创作项目</button>
                    ) : null}

                  </>
                )}
                {item.topicId && openTopic ? <button type="button" className="proposal-action" onClick={() => openTopic(item.topicId!)}>关联主题</button> : null}
                <button type="button" className="proposal-action" aria-expanded={detailId === item.planItemId} onClick={() => void openDetail(item.planItemId)}>{detailId === item.planItemId ? '收起详情' : '查看详情'}</button>
              </div>
            </div>
            {detailPanel(item)}
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
          return (<div className="proposal-terminal-item" key={item.planItemId}>
          <article
            className={`proposal-row${selectedItem?.id === item.planItemId ? ' selected' : ''}${checked ? ' checked' : ''}${batchMode ? ' batch' : ''}`}
            title={selectedItem?.id === item.planItemId ? '再次点击取消 Pi 焦点' : '点击设为 Pi 焦点（不进入详情）'}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button, a, input, label')) return;
              focusPlanItem(item);
            }}
          >
            {batchMode && batchSupported ? (
              <label className="proposal-check" onClick={(event) => event.stopPropagation()} title="勾选以批量恢复">
                <input type="checkbox" checked={checked} onChange={() => toggleChecked(item.planItemId)} aria-label={`勾选 ${item.title}`} />
              </label>
            ) : null}
            <div className="proposal-row-main">
              <strong className="proposal-row-title">{item.title}</strong>
              <div className="proposal-row-meta">
                <span className="proposal-row-date">选题日 {item.planDate}</span>
                {written ? <span className="proposal-row-written" title="写入时间">{written}</span> : null}
                <span className={`pill proposal-state state-${item.state}`}>{STATE_LABELS[item.state as keyof typeof STATE_LABELS]}</span>
                {item.state === 'dismissed' && item.carry?.reason ? <span className="proposal-dismiss-reason" title="否掉原因">{item.carry.reason}</span> : null}
                {item.topicId && openTopic ? <button type="button" className="proposal-action" onClick={() => openTopic(item.topicId!)}>主题</button> : null}
              </div>
              {(item as unknown as { scoreSnapshot?: { total:number; audienceFit:number; viewpointRoom:number; evidenceAvailability:number; timelinessLifecycle:number; articleVideoTransfer:number; executionCost:number; risks: string[]; route?:string; proposalReason?:string } }).scoreSnapshot ? (() => {
                const ss = (item as unknown as { scoreSnapshot: { total:number; audienceFit:number; viewpointRoom:number; evidenceAvailability:number; timelinessLifecycle:number; articleVideoTransfer:number; executionCost:number; risks: string[]; route?:string; proposalReason?:string } }).scoreSnapshot;
                return <div className="proposal-score-breakdown" data-testid="zhihu-score-breakdown" style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                  <span>评分 {ss.total} ｜ 受众{ss.audienceFit}/25 观点{ss.viewpointRoom}/20 证据{ss.evidenceAvailability}/20 时效{ss.timelinessLifecycle}/15 转化{ss.articleVideoTransfer}/15 成本{ss.executionCost}/5</span>
                  {ss.risks?.length ? <span style={{ marginLeft: '8px', color: 'var(--danger)' }}>风险:{ss.risks.join(',')}</span> : null}
                  {ss.route ? <span style={{ marginLeft: '8px' }}>路由:{ss.route}</span> : null}
                </div>;
              })() : null}
            </div>
            <div className="proposal-row-actions">
              {item.state === 'adopted' && item.adoptedProjectId ? <button type="button" className="proposal-go-studio" onClick={() => onOpenProject(item.adoptedProjectId!)}>去创作 ›</button> : null}
              {item.state === 'dismissed' ? <button type="button" className="proposal-go-studio" onClick={() => void restoreOne(item.planItemId)}>恢复</button> : null}
              <button type="button" className="proposal-go-studio" onClick={() => void openDetail(item.planItemId)}>{detailId === item.planItemId ? '收起详情' : '查看完整方案'}</button>
            </div>
          </article>
          {detailPanel(item)}</div>);
        })}</div>}

    {items.length > 0 ? (
      <footer className="proposal-pager">
        <span>已显示 {items.length} / {total} 条</span>
        {(showBackToTop || showLoadMore) ? (
          <div className="proposal-pager-actions">
            {showBackToTop ? <button type="button" className="secondary-button" disabled={loading} onClick={() => { pageRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); void load(tab, 0, false); }}>回到顶部</button> : null}
            {showLoadMore ? <button type="button" className="secondary-button" disabled={loading} onClick={() => void load(tab, items.length, true)}>{loading ? '加载中…' : '加载更多'}</button> : null}
          </div>
        ) : null}
      </footer>
    ) : null}
  </section>;
}
