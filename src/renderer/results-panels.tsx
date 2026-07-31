import type { PostView } from './results-charts';
import { fmtNum } from './results-charts';
import { PlatformMark } from './platform-mark';

// WMB-1510 结果页面板层:周期概览 / 模式发现 / 方法库回摆 / 行动聚合 / 待复盘队列
export type PatternCard = { title: string; ratio: number | null; desc: string; evidence: number; ok: boolean; prompt: string };
export type ActionItem = { txt: string; count: number; adopted: number };
export type ActionColumns = { keep: ActionItem[]; stop: ActionItem[]; change: ActionItem[] };

export function HeroPanel({ total, reviewed, pending, best, medianV24, topPattern, topActions, onDiscuss }: {
  total: number; reviewed: number; pending: number;
  best: PostView | null; medianV24: number;
  topPattern: PatternCard | null;
  topActions: { keep?: string; stop?: string; change?: string };
  onDiscuss: () => void;
}): React.JSX.Element {
  const multiple = best && medianV24 > 0 ? (best.v24 ?? 0) / medianV24 : 0;
  return <section className="rl-hero">
    <div className="rl-hero-head">
      <div className="rl-who"><span className="rl-dot"/><b>本周期概览</b><span className="rl-pill">由 {total} 条已发布内容实时计算</span></div>
      <button className="secondary-button" onClick={onDiscuss}>和 Pi 讨论本周期</button>
    </div>
    <div className="rl-hero-points">
      <div className="rl-pt"><b>① 本期最强内容</b>{best
        ? <p>《{best.title}》24h 阅读 <span className="num">{fmtNum(best.v24 ?? 0)}</span>，是中位水平的 <span className="num">{multiple.toFixed(1)}×</span>。</p>
        : <p>本周期还没有带指标的内容。</p>}</div>
      <div className="rl-pt"><b>② 最稳的模式</b>{topPattern && topPattern.ratio !== null
        ? <p>{topPattern.title}，倍数 <span className="num">{topPattern.ratio.toFixed(1)}×</span>（证据 {topPattern.evidence} 帖）。</p>
        : <p>样本不足，继续积累数据。</p>}</div>
      <div className="rl-pt"><b>③ 需要处理</b><p>{pending > 0
        ? <>有 <span className="num">{pending}</span> 条内容发布超过 72h 还没有复盘，见底部待复盘队列。</>
        : <>本周期 {reviewed}/{total} 条已复盘，没有遗留。</>}</p></div>
    </div>
    <div className="rl-hero-ksc">
      <span className="k"><b>✓ 保留</b>{topActions.keep ?? '—'}</span>
      <span className="s"><b>✕ 停止</b>{topActions.stop ?? '—'}</span>
      <span className="c"><b>↻ 改变</b>{topActions.change ?? '—'}</span>
    </div>
  </section>;
}

export function ActionsPanel({ columns }: { columns: ActionColumns }): React.JSX.Element {
  const cols = [
    { key: 'keep' as const, icon: '✓ 保留 Keep', cls: 'keep' },
    { key: 'stop' as const, icon: '✕ 停止 Stop', cls: 'stop' },
    { key: 'change' as const, icon: '↻ 改变 Change', cls: 'change' }
  ];
  return <section className="rl-panel rl-actions">
    <div className="rl-panel-head rl-actions-head">
      <p className="eyebrow">行动聚合</p>
      <span/>
    </div>
    <div className="rl-actions-grid">
      {cols.map((col) => {
        const items = columns[col.key];
        const total = items.reduce((s, i) => s + i.count, 0);
        return <div className={`rl-action-col ${col.cls}`} key={col.key}>
          <h4>{col.icon}<span className="cnt num">{total} 条</span></h4>
          {items.length ? items.map((i) => <div className="rl-action-item" key={i.txt}>
            <span className="txt">{i.txt}</span>
            <span className="meta"><span>×{i.count} 次复盘提出</span>{i.adopted > 0
              ? <span className="loop-ok">→ 已被 {i.adopted} 个后续方案采用</span>
              : <span className="loop-no">→ 尚未进入方案</span>}</span>
          </div>) : <div className="rl-action-item"><span className="txt rl-hint">本周期暂无</span></div>}
        </div>;
      })}
    </div>
  </section>;
}

export function PendingPanel({ posts, busy, onOpen, onReviewOne, onReviewAll }: {
  posts: PostView[]; busy: boolean;
  onOpen: (post: PostView) => void;
  onReviewOne: (post: PostView) => void;
  onReviewAll: () => void;
}): React.JSX.Element {
  return <section className="rl-panel">
    <div className="rl-panel-head rl-actions-head">
      <p className="eyebrow">待复盘</p>
      {posts.length > 0 && <button className="mini-btn" disabled={busy} onClick={onReviewAll}>让 Pi 全部复盘</button>}
    </div>
    <div className="rl-pending-list">
      {!posts.length && <div className="rl-empty-note">本周期没有遗留未复盘内容。Pi 会在发布 72h 后把未复盘内容列到这里。</div>}
      {posts.slice(0, 6).map((p) => <div className="rl-pending-row" key={p.id}>
        <span className={`pf-tag ${p.platform}`}><PlatformMark platform={p.platform}/></span>
        <span className="ttl" onClick={() => onOpen(p)}>《{p.title}》</span>
        <span className="meta">{p.daysAgo} 天前 · {p.v24 !== null ? `24h 阅读 ${fmtNum(p.v24)}` : '无快照'}</span>
        <button className="mini-btn" disabled={busy} onClick={() => onReviewOne(p)}>让 Pi 复盘</button>
      </div>)}
      {posts.length > 6 && <div className="rl-empty-note">还有 {posts.length - 6} 条 · 可用右上角「让 Pi 全部复盘」批量生成草案</div>}
    </div>
  </section>;
}
