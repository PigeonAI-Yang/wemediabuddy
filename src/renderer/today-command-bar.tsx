// WMB-5340 今日经营概况: primary CTA 去创作 (via view.primaryCta.label) + 4 metrics 趋势
import { useState } from 'react';
import type { TodayRunView, TodaySecondaryId } from './today-run-view';
import './styles-today-overview.css';

type OverviewMetric = { value: number | null; changeText: string; changeTone?: 'up' | 'down' | 'neutral'; series: Array<number | null> };
type OverviewMetrics = { updatedAt: string; sources: OverviewMetric; opportunities: OverviewMetric; projects: OverviewMetric & { pending: number | null }; publications: OverviewMetric } | null;
type ProposalLedgerSummary = {
  total: number;
  todayReady: number;
  carriedReady: number;
  needsAttention: number;
  onOpen: () => void;
};

export function TodayCommandBar(props: {
  view: TodayRunView;
  taskId?: string;
  planDate: string;
  onPrimary: () => void;
  onSecondary: (id: TodaySecondaryId) => void;
  metrics?: OverviewMetrics;
  onMetricClick?: (id: 'sources' | 'opportunities' | 'projects' | 'publications') => void;
  onDailyAutomation?: () => void;
  proposalLedger?: ProposalLedgerSummary;
}): React.JSX.Element {
  const { view, onPrimary, onSecondary, metrics, onMetricClick, onDailyAutomation, proposalLedger } = props;
  const running = view.step === 'starting' || view.step === 'scanning' || view.step === 'judging';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ratioPct = view.progress?.ratio != null ? Math.round(Math.max(0, Math.min(1, view.progress.ratio)) * 100) : 0;
  const barWidth = view.progress?.indeterminate ? 36 : Math.max(ratioPct, running ? 6 : 0);
  const updatedLabel = metrics?.updatedAt ? new Date(metrics.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
  const primaryLabel = view.primaryCta.label;
  const secondaryViewSources = view.secondaryCtas.find((c) => c.id === 'view_sources');
  const secondaryRefresh = view.secondaryCtas.find((c) => c.id === 'refresh');

  function MicroTrend({ series, tone }: { series: Array<number | null>; tone?: string }) {
    const valid = series.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (valid.length < 2) return <span className="today-metric-trend-empty">趋势数据不足</span>;
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = max - min || 1;
    const w = 60; const h = 24; const pad = 2;
    const step = valid.length > 1 ? (w - pad * 2) / (valid.length - 1) : 0;
    // map valid indices to positions; null gaps break line - we simplify to valid only
    const points = valid.map((v, i) => {
      const x = pad + i * step;
      const y = pad + (1 - (v - min) / range) * (h - pad * 2);
      return `${x},${y}`;
    }).join(' ');
    const color = tone === 'up' ? 'var(--success)' : tone === 'down' ? 'var(--danger)' : 'var(--muted-low)';
    return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`7日趋势 ${valid.join(',')}`}><polyline fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" points={points} /></svg>;
  }

  const metricsConfig: Array<{ id: 'sources' | 'opportunities' | 'projects' | 'publications'; label: string; metric?: OverviewMetric }> = [
    { id: 'sources', label: '今日新增来源', metric: metrics?.sources },
    { id: 'opportunities', label: '内容机会', metric: metrics?.opportunities },
    { id: 'projects', label: '进行中项目', metric: metrics?.projects },
    { id: 'publications', label: '近 7 日发布', metric: metrics?.publications },
  ];

  return (
    <section className="today-overview" aria-label="今日经营概况">
      <div className="today-overview-head">
        <div className="today-overview-title">
          <h2>今日经营概况</h2>
          {updatedLabel ? <button type="button" className="today-overview-updated" onClick={() => onDailyAutomation?.()} title="前往 每日自动化">更新于 {updatedLabel}</button> : null}
        </div>
        <div className="today-overview-actions">
          {secondaryRefresh ? <button type="button" className="secondary-button" onClick={() => onSecondary('refresh')} aria-label="重新侦察">重新侦察</button> : null}
          {secondaryViewSources ? <button type="button" className="secondary-button" onClick={() => onSecondary('view_sources')}>查看资料</button> : null}
          {primaryLabel && view.primaryCta.kind !== 'none' ? <button type="button" className="primary-button" onClick={onPrimary}>{primaryLabel}</button> : null}
        </div>
        {running && view.detail ? <p className="today-overview-detail" aria-live="polite" aria-atomic="true">{view.detail}</p> : null}
      </div>
      {running ? <div className="today-overview-run"><div className="intelligence-bar" data-indeterminate={view.progress?.indeterminate || undefined} aria-label={view.progress?.label || view.headline}><i style={{ width: `${barWidth}%` }} /></div>{(view.progress?.diagnostics?.length || view.progress?.stalled) ? <details className="today-command-diagnostics" open={detailsOpen} onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}><summary>详情</summary><ul>{(view.progress?.diagnostics || []).map((line) => <li key={line}>{line}</li>)}{view.progress?.stalled ? <li>已等待 {formatWait(view.progress.stalled.waitSec)}，可取消后重试</li> : null}</ul></details> : null}</div> : null}
      <div className="today-overview-metrics" role="group" aria-label="经营指标">
        {metricsConfig.map((item) => {
          const m = item.metric;
          const unknown = !m || m.value == null;
          const val = unknown ? '—' : String(m!.value);
          const change = unknown ? '—' : m!.changeText;
          const tone = unknown ? undefined : m!.changeTone;
          return (
            <button key={item.id} type="button" className="today-metric" title={item.id === 'sources' ? '新收集的来源记录，不是已选选题' : undefined} onClick={() => onMetricClick?.(item.id)} aria-label={`${item.label} ${unknown ? '未知' : val} ${change}${item.id === 'sources' ? '，新收集的来源记录，不是已选选题' : ''}`}>
              <span className="today-metric-label">{item.label}</span>
              <span className="today-metric-value" data-unknown={unknown ? 'true' : undefined}>{val}</span>
              <span className="today-metric-change" data-tone={tone}>{change}</span>
              <span className="today-metric-trend">{m ? <MicroTrend series={m.series} tone={tone} /> : <span className="today-metric-trend-empty">—</span>}</span>
            </button>
          );
        })}
      </div>
      {proposalLedger ? <button type="button" className="proposal-ledger-entry" onClick={proposalLedger.onOpen} title="打开选题台账">
        <span className="proposal-ledger-entry-title">选题台账 · {proposalLedger.total}</span>
        <span className="proposal-ledger-entry-counts">今日待批准 · {proposalLedger.todayReady} ｜ 跨日待批准 · {proposalLedger.carriedReady} ｜ 待评分/待修复 · {proposalLedger.needsAttention}</span>
        <span className="proposal-ledger-entry-arrow" aria-hidden="true">›</span>
      </button> : null}
    </section>
  );
}

function formatWait(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m${sec}s` : `${min}m`;
}
