import { useEffect, useMemo, useState } from 'react';
import type { KnowledgeFlywheelListResult, KnowledgeHealthIssueRecord } from '../shared/knowledge-flywheel';
import { issueTypeLabel, severityLabel } from './knowledge-canvas-projection';
import { healthSeverityCls, healthStatusLabel } from './library-view-parts';
import {
  formatHealthTime,
  mergeResultsHealthIssues,
  resolveResultsHealthIssue,
  resultsHealthStatusCls,
  shouldRefreshResultsHealth,
  RESULTS_HEALTH_AFFECTED_TYPES,
  RESULTS_HEALTH_ISSUE_TYPES,
  RESULTS_HEALTH_QUERY_LIMIT,
  type ResultsHealthContext,
} from './results-health';

// WMB-5216 结果页「知识健康 · 结果回流」有界区域：只读投影同一 HealthIssue identity，
// 复用 listHealthIssues preload 通道；订阅 dataChanged health/knowledge/receipt scope 自动刷新。
// 深链只走本页已有发布钻取（onOpenPublication → setSelectedId），无额外路由。
export function ResultsHealthPanel({ publications, reviews, snapshots, onOpenPublication }: {
  publications: ResultsHealthContext['publications'];
  reviews: ResultsHealthContext['reviews'];
  snapshots: ResultsHealthContext['snapshots'];
  onOpenPublication: (publicationId: string) => void;
}): React.JSX.Element {
  const [issues, setIssues] = useState<KnowledgeHealthIssueRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshNote, setRefreshNote] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const queries: Array<Promise<KnowledgeFlywheelListResult<KnowledgeHealthIssueRecord>>> = [
        ...RESULTS_HEALTH_ISSUE_TYPES.map((issueType) => window.wmb.listHealthIssues({ issueType, limit: RESULTS_HEALTH_QUERY_LIMIT })),
        ...RESULTS_HEALTH_AFFECTED_TYPES.map((affectedObjectType) => window.wmb.listHealthIssues({ affectedObjectType, limit: RESULTS_HEALTH_QUERY_LIMIT }))
      ];
      const pages = await Promise.all(queries);
      setIssues(mergeResultsHealthIssues(pages));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    if (typeof window.wmb.onDataChanged !== 'function') return;
    return window.wmb.onDataChanged((event) => {
      if (!shouldRefreshResultsHealth(event.scopes)) return;
      void load();
      setRefreshNote('已自动更新');
    });
  }, []);
  useEffect(() => {
    if (!refreshNote) return;
    const timer = window.setTimeout(() => setRefreshNote(''), 4000);
    return () => window.clearTimeout(timer);
  }, [refreshNote]);

  const context = useMemo<ResultsHealthContext>(
    () => ({ publications, reviews, snapshots }),
    [publications, reviews, snapshots]
  );

  return <section className="rl-panel rl-health" aria-label="知识健康 · 结果回流">
    <div className="rl-panel-head rl-actions-head">
      <p className="eyebrow">知识健康 · 结果回流</p>
      <span className="rl-health-count num">{issues.length} 条</span>
    </div>
    {refreshNote ? <p className="rl-health-note" role="status">{refreshNote}</p> : null}
    {error ? <div className="rl-health-error" role="alert">
      <p>健康问题读取失败：{error}</p>
      <button className="mini-btn" onClick={() => void load()}>重试</button>
    </div> : null}
    {loading && !issues.length ? <p className="rl-health-loading" role="status">正在读取健康问题…</p>
      : !issues.length ? <div className="rl-empty-note">没有与结果/复盘相关的知识健康问题。复盘定稿并回流到知识库后，这里会自动更新。</div>
      : <ul className="rl-health-list">{issues.map((issue) => {
        const { target, affectedLabel } = resolveResultsHealthIssue(issue, context);
        return <li className="rl-health-item" key={issue.id}>
          <div className="rl-health-head">
            <span className={`issue-severity ${healthSeverityCls(issue.severity)}`}>{severityLabel(issue.severity)}</span>
            <span className="tag issue-type">{issueTypeLabel(issue.issueType)}</span>
            <span className={`pill-status ${resultsHealthStatusCls(issue.status)}`}><span className="dot"/>{healthStatusLabel(issue.status)}</span>
          </div>
          <p className="rl-health-affected">影响对象：{affectedLabel}</p>
          <p className="rl-health-summary">{issue.suggestedAction}</p>
          <div className="rl-health-actions">
            {target ? <button className="mini-btn" onClick={() => onOpenPublication(target.publicationId)}>打开《{target.title}》</button> : <span/>}
            <span className="rl-health-meta">问题 {issue.id} · 检测于 {formatHealthTime(issue.detectedAt)}</span>
          </div>
        </li>;
      })}</ul>}
  </section>;
}
