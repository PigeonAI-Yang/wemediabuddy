import { useCallback, useEffect, useState } from 'react';
import { formatScoreWithPending, getScoreReasons, isPendingScore } from './proposal-ledger';
type YesterdayTarget = {
  id: string;
  target_kind: 'draft_revision' | 'published_revision' | string;
  project_id: string | null;
  predecessor_content_version_id?: string | null;
  predecessor_publication_id?: string | null;
  status: string;
  score_snapshot_json?: string | null;
  predecessor_target_id?: string | null;
  carry_depth?: number | null;
  created_at?: string;
  updated_at?: string;
};

type YesterdayProjection = {
  cycle: Record<string, unknown> | null;
  draftIterations: YesterdayTarget[];
  publishedIterations: YesterdayTarget[];
};

const STATUS_LABEL: Record<string, string> = {
  selected: '待修订',
  researching: '研究中',
  drafting: '草稿修订中',
  article_ready: '待完善',
  scripting: '脚本中',
  completed: '已完成',
  blocked: '已阻塞',
  skipped: '已跳过',
  carried: '已顺延',
};

function parseSnapshot(json: string | null | undefined): { reviews: unknown[]; snapshots: unknown[]; evidence: unknown[]; collectedAt?: string } {
  if (!json || typeof json !== 'string') return { reviews: [], snapshots: [], evidence: [] };
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const reviews = Array.isArray(v.reviews) ? (v.reviews as unknown[]) : [];
    const snapshots = Array.isArray(v.snapshots) ? (v.snapshots as unknown[]) : [];
    const evidence = Array.isArray(v.evidence) ? (v.evidence as unknown[]) : [];
    const collectedAt = typeof v.collectedAt === 'string' ? v.collectedAt : undefined;
    return { reviews, snapshots, evidence, collectedAt };
  } catch {
    return { reviews: [], snapshots: [], evidence: [] };
  }
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function EvidenceSummary({ item }: { item: YesterdayTarget }): React.JSX.Element {
  const { reviews, snapshots, evidence } = parseSnapshot(item.score_snapshot_json ?? null);
  const parts: string[] = [];
  if (item.target_kind === 'draft_revision') {
    if (reviews.length) parts.push(`笔记/建议 ${reviews.length}`);
    if (evidence.length) parts.push(`上下文 ${evidence.length}`);
    if (!parts.length) parts.push('暂无建议上下文');
  } else {
    if (reviews.length) parts.push(`复盘建议 ${reviews.length}`);
    if (snapshots.length) parts.push(`数据快照 ${snapshots.length}`);
    if (evidence.length) parts.push(`关联来源 ${evidence.length}`);
    if (!parts.length) parts.push('暂无复盘上下文');
  }
  return <span>{parts.join(' · ')}</span>;
}

function ScoreHonest({ json }: { json: string | null | undefined }): React.JSX.Element {
  const score = getScoreReasons({ score_snapshot_json: json } as unknown as Record<string, unknown>);
  const display = formatScoreWithPending(score, score?.status === 'pending' ? 'draft' : undefined);
  // Pending must show —, never 100
  const isPending = !score || score.status === 'pending' || isPendingScore(score);
  return <span className={`today-yesterday-score ${isPending ? 'today-yesterday-score--pending' : ''}`} aria-label={display}>{display}</span>;
}

function StatusChip({ status }: { status: string }): React.JSX.Element {
  const label = STATUS_LABEL[status] ?? status;
  const mod = status === 'skipped' ? 'skipped' : status === 'carried' ? 'carried' : status === 'completed' ? 'completed' : status === 'blocked' ? 'blocked' : 'selected';
  return <span className={`today-yesterday-status today-yesterday-status--${mod}`}>{label}</span>;
}

export function TodayYesterdayIteration({
  businessDate,
  openStudio,
}: {
  businessDate: string;
  openStudio: (projectId?: string) => void;
}): React.JSX.Element {
  const [projection, setProjection] = useState<YesterdayProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const wmbBridge = window.wmb as unknown as { getYesterdayIteration: (d: string) => Promise<YesterdayProjection> };
      const raw = await wmbBridge.getYesterdayIteration(businessDate);
      const data = raw as YesterdayProjection;
      if (data && typeof data === 'object' && 'draftIterations' in data && 'publishedIterations' in data) {
        setProjection({
          cycle: (data.cycle as Record<string, unknown> | null) ?? null,
          draftIterations: Array.isArray(data.draftIterations) ? (data.draftIterations as YesterdayTarget[]) : [],
          publishedIterations: Array.isArray(data.publishedIterations) ? (data.publishedIterations as YesterdayTarget[]) : [],
        });
      } else {
        setProjection({ cycle: null, draftIterations: [], publishedIterations: [] });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [businessDate]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setProjection(null);
    setLoading(true);
    setError('');
  }, [businessDate]);

  useEffect(() => {
    const wmbBridge = window.wmb as unknown as { onDataChanged?: (cb: (e: { scopes: string[] }) => void) => () => void };
    const off = wmbBridge.onDataChanged?.((e) => {
      if (e.scopes.includes('today') || e.scopes.includes('studio') || e.scopes.includes('publications')) void load();
    });
    return () => { off?.(); };
  }, [load]);

  const draftIterations = projection?.draftIterations ?? [];
  const publishedIterations = projection?.publishedIterations ?? [];
  const total = draftIterations.length + publishedIterations.length;

  return (
    <section className="today-yesterday-iteration" aria-labelledby="today-yesterday-title" data-testid="today-yesterday-iteration">
      <header className="today-yesterday-head">
        <div className="today-yesterday-head-main">
          <h2 id="today-yesterday-title" className="today-yesterday-title">昨日迭代</h2>
          <span className="today-yesterday-counts" aria-live="polite">
            {loading ? '加载中' : `未发布草稿 ${draftIterations.length} · 已发布内容 ${publishedIterations.length}`}
          </span>
        </div>
        <button
          type="button"
          className="text-button today-yesterday-refresh"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新昨日迭代"
        >
          刷新
        </button>
      </header>

      {loading ? (
        <p className="today-yesterday-msg today-yesterday-msg--loading" role="status" aria-live="polite">正在加载昨日迭代…</p>
      ) : error ? (
        <div className="today-yesterday-error" role="alert">
          <p className="today-yesterday-msg today-yesterday-msg--error">加载失败：{error}</p>
          <button type="button" className="secondary-button" onClick={() => void load()} aria-label="重试加载昨日迭代">重试</button>
        </div>
      ) : !projection?.cycle ? (
        <p className="today-yesterday-empty">昨日暂无迭代周期 · 完成今日编排后可在此修订昨日草稿与已发布内容</p>
      ) : total === 0 ? (
        <p className="today-yesterday-empty">昨日暂无迭代队列 · 未发布草稿与已发布内容均为空</p>
      ) : (
        <div className="today-yesterday-queues">
          <section className="today-yesterday-queue" aria-labelledby="today-yesterday-draft-title">
            <div className="today-yesterday-queue-head">
              <h3 id="today-yesterday-draft-title" className="today-yesterday-queue-title">未发布草稿</h3>
              <span className="today-yesterday-queue-count">{draftIterations.length} 项</span>
              <span className="today-yesterday-queue-hint">待修订 · 建议与上下文为修订依据</span>
            </div>
            {draftIterations.length === 0 ? (
              <p className="today-yesterday-queue-empty">暂无未发布草稿迭代</p>
            ) : (
              <ul className="today-yesterday-list" role="list" aria-label="未发布草稿修订队列">
                {draftIterations.map((item) => {
                  const carryDepth = typeof item.carry_depth === 'number' ? item.carry_depth : 0;
                  return (
                    <li key={item.id} className="today-yesterday-item" role="listitem" data-target-id={item.id} data-target-kind={item.target_kind}>
                      <div className="today-yesterday-item-main">
                        <div className="today-yesterday-item-title" title={item.project_id ?? undefined}>
                          {item.project_id ? `项目 ${shortId(item.project_id)}` : `迭代 ${shortId(item.id)}`}
                          {carryDepth > 0 ? <span className="today-yesterday-carry"> · 已顺延 {carryDepth}</span> : null}
                        </div>
                        <div className="today-yesterday-item-meta">
                          <StatusChip status={item.status} />
                          <span className="today-yesterday-evidence"><EvidenceSummary item={item} /></span>
                          <ScoreHonest json={item.score_snapshot_json} />
                        </div>
                        {item.score_snapshot_json ? (
                          <p className="today-yesterday-context">建议/上下文来源：score_snapshot_json · 修订不覆盖原版本，仅追加新版本</p>
                        ) : (
                          <p className="today-yesterday-context today-yesterday-context--pending">评分：待补证据（—）· 暂无上下文</p>
                        )}
                      </div>
                      <div className="today-yesterday-item-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => openStudio(item.project_id ?? undefined)}
                          aria-label={item.project_id ? `打开工作室修订项目 ${item.project_id}` : '打开工作室'}
                        >
                          打开工作室
                        </button>
                        <span className="today-yesterday-state" aria-label={`修订状态 ${STATUS_LABEL[item.status] ?? item.status}`}>
                          {item.status === 'skipped' ? '已跳过' : item.status === 'carried' ? '已顺延' : '待修订'}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="today-yesterday-queue" aria-labelledby="today-yesterday-published-title">
            <div className="today-yesterday-queue-head">
              <h3 id="today-yesterday-published-title" className="today-yesterday-queue-title">已发布内容</h3>
              <span className="today-yesterday-queue-count">{publishedIterations.length} 项</span>
              <span className="today-yesterday-queue-hint">已发布复盘 · 建议与快照为修订依据</span>
            </div>
            {publishedIterations.length === 0 ? (
              <p className="today-yesterday-queue-empty">暂无已发布内容迭代</p>
            ) : (
              <ul className="today-yesterday-list" role="list" aria-label="已发布内容修订队列">
                {publishedIterations.map((item) => {
                  const carryDepth = typeof item.carry_depth === 'number' ? item.carry_depth : 0;
                  return (
                    <li key={item.id} className="today-yesterday-item" role="listitem" data-target-id={item.id} data-target-kind={item.target_kind}>
                      <div className="today-yesterday-item-main">
                        <div className="today-yesterday-item-title" title={item.project_id ?? undefined}>
                          {item.project_id ? `项目 ${shortId(item.project_id)}` : `迭代 ${shortId(item.id)}`}
                          {carryDepth > 0 ? <span className="today-yesterday-carry"> · 已顺延 {carryDepth}</span> : null}
                        </div>
                        <div className="today-yesterday-item-meta">
                          <StatusChip status={item.status} />
                          <span className="today-yesterday-evidence"><EvidenceSummary item={item} /></span>
                          <ScoreHonest json={item.score_snapshot_json} />
                        </div>
                        {item.predecessor_publication_id ? (
                          <p className="today-yesterday-context">前置发布 {shortId(item.predecessor_publication_id)} · 上下文包含复盘建议与数据快照</p>
                        ) : (
                          <p className="today-yesterday-context today-yesterday-context--pending">评分：待补证据（—）</p>
                        )}
                      </div>
                      <div className="today-yesterday-item-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => openStudio(item.project_id ?? undefined)}
                          aria-label={item.project_id ? `打开工作室修订已发布项目 ${item.project_id}` : '打开工作室'}
                        >
                          打开工作室
                        </button>
                        <span className="today-yesterday-state" aria-label={`修订状态 ${STATUS_LABEL[item.status] ?? item.status}`}>
                          {item.status === 'skipped' ? '已跳过' : item.status === 'carried' ? '已顺延' : '待修订'}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
      <p className="today-yesterday-footnote">修订仅在工作室追加新版本，不直接发布；跳过与顺延状态由目标状态呈现</p>
    </section>
  );
}
// Page-neutral alias for Results → 复盘 (WMB-5340): same behavior, neutral presentation
export const ResultsYesterdayIteration = TodayYesterdayIteration;
export const YesterdayIteration = TodayYesterdayIteration;
