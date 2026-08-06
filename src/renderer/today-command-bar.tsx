import { useState } from 'react';
import { TodayScoutCreature } from './today-scout-creature';
import type { TodayRunView, TodaySecondaryId } from './today-run-view';

export function TodayCommandBar(props: {
  view: TodayRunView;
  taskId?: string;
  planDate: string;
  onPrimary: () => void;
  onSecondary: (id: TodaySecondaryId) => void;
}): React.JSX.Element {
  const { view, onPrimary, onSecondary } = props;
  const running = view.step === 'starting' || view.step === 'scanning' || view.step === 'judging';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ratioPct = view.progress?.ratio != null ? Math.round(Math.max(0, Math.min(1, view.progress.ratio)) * 100) : 0;
  const barWidth = view.progress?.indeterminate ? 36 : Math.max(ratioPct, running ? 6 : 0);

  return (
    <section
      className="today-command"
      data-mode={running ? 'running' : 'idle'}
      aria-live={running ? 'polite' : undefined}
      aria-label={running ? '今日情报运行中' : '今日概览'}
    >
      <div className="today-command-state" data-mode={running ? 'running' : 'idle'}>
        {running ? (
          <>
            <TodayScoutCreature />
            <div className="today-command-run">
              <div className="today-command-run-head">
                <div className="today-command-run-title">
                  <strong>{view.headline}</strong>
                  {view.progress?.currentSource ? <span className="intelligence-source">当前：{view.progress.currentSource}</span> : null}
                </div>
                <div className="today-command-run-meta">
                  {view.progress?.stalled ? <em className="intelligence-stalled-pill">已等待 {formatWait(view.progress.stalled.waitSec)}</em> : null}
                  <span>{view.progress?.label || ''}</span>
                </div>
              </div>
              <div
                className="intelligence-bar"
                data-indeterminate={view.progress?.indeterminate || undefined}
                aria-label={view.progress?.label || view.headline}
              >
                <i style={{ width: `${barWidth}%` }} />
              </div>
              <p className="today-command-detail">{view.detail}</p>
              {(view.progress?.diagnostics?.length || view.progress?.stalled) ? (
                <details className="today-command-diagnostics" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.target as HTMLDetailsElement).open)}>
                  <summary>详情</summary>
                  <ul>
                    {(view.progress?.diagnostics || []).map((line) => <li key={line}>{line}</li>)}
                    {view.progress?.stalled ? <li>已等待 {formatWait(view.progress.stalled.waitSec)}，可取消后重试</li> : null}
                  </ul>
                </details>
              ) : null}
            </div>
            <div className="today-command-actions">
              {view.secondaryCtas.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="secondary-button"
                  disabled={action.disabled}
                  onClick={() => onSecondary(action.id)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="today-command-line">{view.headline}</p>
            {view.detail ? <p className="today-command-detail">{view.detail}</p> : null}
            {view.stats && view.stats.length > 0 ? (
              <div className="today-command-stats" aria-label="今日指标">
                {view.stats.map((stat) => (
                  <div className="today-command-stat" key={stat.label}>
                    <span className="stat-label">{stat.label}</span>
                    <strong className="stat-value" data-tone={stat.tone}>{stat.value}</strong>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="today-command-actions">
              {view.secondaryCtas.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={action.id === 'refresh' ? 'refresh-button' : 'secondary-button'}
                  title={action.id === 'refresh' ? '刷新' : undefined}
                  aria-label={action.id === 'refresh' ? '刷新' : undefined}
                  disabled={action.disabled}
                  onClick={() => onSecondary(action.id)}
                >
                  {action.id === 'refresh' ? '↻' : action.label}
                </button>
              ))}
              {view.primaryCta.kind !== 'none' && view.primaryCta.label ? (
                <button type="button" className="primary-button" onClick={onPrimary}>{view.primaryCta.label}</button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function formatWait(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m${sec}s` : `${min}m`;
}
