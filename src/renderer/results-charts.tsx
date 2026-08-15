import { useState } from 'react';

// WMB-1510 结果页图表层:散点 / 分位带 / 热图 / 原位钻取(纯 SVG,无图表库)
export type MetricField = { status: string; value?: number; rawLabel?: string };
export type MetricSnapshotRow = {
  id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string;
  normalized: Record<string, MetricField>; raw: Record<string, MetricField>;
};
export type PostPoint = { hours: number; value: number; snap: MetricSnapshotRow };
export type PostView = {
  id: string; title: string; platform: string; format: string;
  publishedAt: string; externalUrl: string; daysAgo: number; hour: number;
  points: PostPoint[]; v24: number | null; reviewed: boolean;
};

export const median = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export const fmtNum = (n: number) => Math.round(n).toLocaleString('zh-CN');
export const platformColor = (platform: string) => `var(--pf-${platform === 'xiaohongshu' ? 'xhs' : platform === 'wechat' ? 'wx' : 'x'})`;

const W = 780, H = 380, M = { l: 56, r: 96, t: 14, b: 36 };
const HOURS = [1, 6, 24, 72];
const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
const yGrid = (lo: number, hi: number) => [0.15, 0.5, 0.85].map((f) => Math.pow(10, lo + f * (hi - lo)));

function Axis({ lo, hi, ys, xLabels, norm }: {
  lo: number; hi: number; ys: (v: number) => number; xLabels: React.ReactNode; norm?: boolean;
}): React.JSX.Element {
  return <>
    {yGrid(lo, hi).map((v, i) => <g key={i}>
      <line className="rc-grid" x1={M.l} x2={W - M.r} y1={ys(v)} y2={ys(v)}/>
      <text x={M.l - 8} y={ys(v) + 3} textAnchor="end">{norm ? '×' : ''}{fmtNum(v)}</text>
    </g>)}
    <line className="rc-axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b}/>
    <line className="rc-axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b}/>
    {xLabels}
  </>;
}

type HoverInfo = { post: PostView; hl: React.ReactNode };
function usePointer(list: PostView[], find: (px: number, py: number) => HoverInfo | null, onSelect: (post: PostView) => void) {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = (e.target as SVGRectElement).ownerSVGElement!;
    const rect = svg.getBoundingClientRect();
    const next = find((e.clientX - rect.left) * W / rect.width, (e.clientY - rect.top) * H / rect.height);
    setHover(next);
    setTip(next ? { x: e.clientX, y: e.clientY } : null);
  };
  const onLeave = () => { setHover(null); setTip(null); };
  const onClick = () => { if (hover) { setTip(null); onSelect(hover.post); } };
  const tooltip = hover && tip ? <div className="rc-tooltip" style={{ left: tip.x + 14, top: tip.y + 10 }}>
    <b>《{hover.post.title}》</b>
    <span>{hover.post.daysAgo} 天前 {hover.post.hour}:00 · {hover.post.points.length} 个快照</span><br/>
    {hover.post.points.length > 0 && <span>{hover.post.points.map((p) => `+${p.hours}h ${fmtNum(p.value)}`).join(' → ')}</span>}
  </div> : null;
  const hitzone = <rect className="rc-hitzone" x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick}/>;
  return { hover, hitzone, tooltip };
}

export function ChartFrame({ children, hitzone, tooltip, legend }: {
  children: React.ReactNode; hitzone?: React.ReactNode; tooltip?: React.ReactNode; legend: React.ReactNode;
}): React.JSX.Element {
  return <div className="rc-frame">
    <svg className="rc-chart" viewBox={`0 0 ${W} ${H}`}>{children}{hitzone}</svg>
    <div className="rc-legend">{legend}</div>
    {tooltip}
  </div>;
}

// 表现散点:x=发布时间, y=24h(或最近窗口)阅读, 每日中位轨迹
export function ScatterChart({ posts, onSelect }: { posts: PostView[]; onSelect: (post: PostView) => void }): React.JSX.Element {
  const dotted = posts.filter((p) => p.v24 !== null);
  if (!dotted.length) return <div className="rc-empty">当前筛选下还没有带指标快照的内容。采集指标后这里会出现散点。</div>;
  const maxDay = Math.max(7, ...dotted.map((p) => Math.ceil(p.daysAgo)));
  const xs = (day: number) => M.l + (1 - day / maxDay) * (W - M.l - M.r);
  const allV = dotted.map((p) => p.v24!);
  const lo = Math.log10(Math.max(1, Math.min(...allV))), hi = Math.log10(Math.max(...allV));
  const ys = (v: number) => M.t + (1 - (Math.log10(Math.max(1, v)) - lo) / Math.max(0.01, hi - lo)) * (H - M.t - M.b);
  const dayTicks = [...new Set([0, 7, 14, 21, 28].filter((d) => d <= maxDay).concat(maxDay))].sort((a, b) => b - a);
  const medPts = [...Array(maxDay + 1).keys()].map((d) => {
    const vs = dotted.filter((p) => Math.floor(p.daysAgo) === d).map((p) => p.v24!);
    return vs.length ? [xs(d), ys(median(vs))] as [number, number] : null;
  });
  const medSegs = medPts.slice(0, -1).map((pt, i) => pt && medPts[i + 1] ? `M${pt[0]},${pt[1]} L${medPts[i + 1]![0]},${medPts[i + 1]![1]}` : '').filter(Boolean);
  const dots = dotted.map((p) => ({ p, x: xs(p.daysAgo), y: ys(p.v24!) }));
  const pointer = usePointer(dotted, (px, py) => {
    let best: (typeof dots)[number] | null = null, bd = 1e9;
    for (const d of dots) { const dist = Math.hypot(px - d.x, py - d.y); if (dist < bd) { bd = dist; best = d; } }
    return best ? { post: best.p, hl: <><circle cx={best.x} cy={best.y} r={7} fill="none" stroke={platformColor(best.p.platform)} strokeWidth={2}/><circle cx={best.x} cy={best.y} r={4} style={{ fill: platformColor(best.p.platform) }}/></> } : null;
  }, onSelect);
  return <ChartFrame hitzone={pointer.hitzone} tooltip={pointer.tooltip} legend={<>
    <span><i style={{ background: 'var(--pf-x)' }}/>X</span><span><i style={{ background: 'var(--pf-xhs)' }}/>小红书</span><span><i style={{ background: 'var(--pf-wx)' }}/>公众号</span>
    <span><i style={{ background: 'var(--accent-hover)', height: '2.5px' }}/>每日中位轨迹</span>
    <span className="rc-legend-note">每个点 = 一条内容的 24h 阅读 · 吸附查看 · 点击钻取</span>
  </>}>
    <Axis lo={lo} hi={hi} ys={ys} xLabels={dayTicks.map((d) => <text key={d} x={xs(d)} y={H - M.b + 18} textAnchor="middle">{d === 0 ? '今天' : `${d} 天前`}</text>)}/>
    {medSegs.map((d, i) => <path key={i} d={d} fill="none" className="rc-medline"/>)}
    {medPts.filter(Boolean).map((pt, i) => <circle key={i} cx={pt![0]} cy={pt![1]} r={3} className="rc-meddot"/>)}
    {dots.map((d) => <circle key={d.p.id} cx={d.x} cy={d.y} r={4} className="rc-dot" style={{ fill: platformColor(d.p.platform) }}/>)}
    {pointer.hover?.hl}
  </ChartFrame>;
}

// 增长形态:纯分位带 + 中位线 + Top3;单帖曲线只在吸附时还原(快照按 hours 桶对齐,容忍缺窗口)
export function BandsChart({ posts, mode, onMode, onSelect }: {
  posts: PostView[]; mode: 'abs' | 'norm'; onMode: (mode: 'abs' | 'norm') => void; onSelect: (post: PostView) => void;
}): React.JSX.Element {
  const dotted = posts.filter((p) => p.points.length >= 2);
  const pv = (p: PostView, pt: PostPoint) => mode === 'norm' ? pt.value / p.points[0].value : pt.value;
  const valAt = (p: PostView, hours: number): number | null => {
    const pt = p.points.find((x) => x.hours === hours);
    return pt ? pv(p, pt) : null;
  };
  if (dotted.length < 2) return <div className="rc-empty">至少需要 2 条带多窗口快照的内容才能聚合增长形态。</div>;
  const xs = (h: number) => M.l + (Math.log10(h) / Math.log10(72)) * (W - M.l - M.r);
  const windows = HOURS.filter((h) => dotted.filter((p) => valAt(p, h) !== null).length >= 2);
  const allV = dotted.flatMap((p) => p.points.map((pt) => pv(p, pt)));
  const lo = Math.log10(Math.max(1, Math.min(...allV))), hi = Math.log10(Math.max(...allV));
  const ys = (v: number) => M.t + (1 - (Math.log10(Math.max(1, v)) - lo) / Math.max(0.01, hi - lo)) * (H - M.t - M.b);
  const q = (hours: number, qq: number) => {
    const s = dotted.map((p) => valAt(p, hours)).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length * qq)] : 0;
  };
  const bandPath = (qa: number, qb: number) => {
    const top = windows.map((h) => [xs(h), ys(q(h, qb))]);
    const bot = windows.map((h) => [xs(h), ys(q(h, qa))]).reverse();
    return `M${[...top, ...bot].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z`;
  };
  const medPath = `M${windows.map((h) => `${xs(h).toFixed(1)},${ys(q(h, 0.5)).toFixed(1)}`).join(' L')}`;
  const top3 = [...dotted].sort((a, b) => (b.v24 ?? 0) - (a.v24 ?? 0)).slice(0, 3);
  const pointer = usePointer(dotted, (px, py) => {
    let best: PostView | null = null, bd = 1e9;
    for (const p of dotted) {
      const pts = p.points.map((pt) => [xs(pt.hours), ys(pv(p, pt))]);
      for (let i = 0; i < pts.length - 1; i++) { const d = segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]); if (d < bd) { bd = d; best = p; } }
    }
    if (!best) return null;
    const bp = best as PostView;
    return { post: bp, hl: <>
      <polyline points={bp.points.map((pt) => `${xs(pt.hours).toFixed(1)},${ys(pv(bp, pt)).toFixed(1)}`).join(' ')} fill="none" stroke={platformColor(bp.platform)} strokeWidth={2.4}/>
      {bp.points.map((pt, wi) => <circle key={wi} cx={xs(pt.hours)} cy={ys(pv(bp, pt))} r={3.4} style={{ fill: platformColor(bp.platform) }}/>)}
    </> };
  }, onSelect);
  return <>
    <div className="rc-opts">
      <div className="rc-tabs-mini">
        <button className={mode === 'abs' ? 'on' : ''} onClick={() => onMode('abs')}>绝对阅读</button>
        <button className={mode === 'norm' ? 'on' : ''} onClick={() => onMode('norm')}>增速形态</button>
      </div>
      <span className="rc-opts-note">{dotted.length} 条内容聚合成带 · 吸附可还原单条曲线</span>
    </div>
    <ChartFrame hitzone={pointer.hitzone} tooltip={pointer.tooltip} legend={<>
      <span><i style={{ background: 'var(--accent-hover)', height: '2.5px' }}/>中位数</span>
      <span><i className="rc-band-p75"/>P25–P75</span><span><i className="rc-band-p90"/>P10–P90</span>
      <span className="rc-legend-note">移动鼠标吸附还原单条曲线 · 点击钻取</span>
    </>}>
      <Axis lo={lo} hi={hi} ys={ys} norm={mode === 'norm'} xLabels={windows.map((h) => <text key={h} x={xs(h)} y={H - M.b + 18} textAnchor="middle">+{h}h</text>)}/>
      <path d={bandPath(0.1, 0.9)} className="rc-band90"/>
      <path d={bandPath(0.25, 0.75)} className="rc-band75"/>
      {top3.map((p) => <g key={p.id}>
        <polyline points={p.points.map((pt) => `${xs(pt.hours).toFixed(1)},${ys(pv(p, pt)).toFixed(1)}`).join(' ')} fill="none" stroke={platformColor(p.platform)} strokeWidth={1.8} opacity={.9}/>
        <text className="rc-endlabel" x={W - M.r + 6} y={ys(pv(p, p.points[p.points.length - 1])) + 3} fill={platformColor(p.platform)}>{p.title.slice(0, 9)}…</text>
      </g>)}
      <path d={medPath} fill="none" className="rc-medline strong"/>
      {windows.map((h) => <circle key={h} cx={xs(h)} cy={ys(q(h, 0.5))} r={3.2} className="rc-meddot"/>)}
      {pointer.hover?.hl}
    </ChartFrame>
  </>;
}

// 形式 × 平台热图:点击单元格 = 按该组合筛选
export function Heatmap({ posts, formats, platformNames, onCell }: {
  posts: PostView[]; formats: Array<[string, string]>; platformNames: Record<string, string>; onCell: (platform: string, format: string) => void;
}): React.JSX.Element {
  const platforms = Object.keys(platformNames);
  const maxV = Math.max(1, ...formats.flatMap(([f]) => platforms.map((pf) => median(posts.filter((p) => p.format === f && p.platform === pf && p.v24 !== null).map((p) => p.v24!)))));
  return <>
    <div className="rc-heatmap">
      <div className="rc-hm-row rc-hm-head"><span/>{platforms.map((pf) => <span key={pf}>{platformNames[pf]}</span>)}</div>
      {formats.map(([fid, fname]) => <div className="rc-hm-row" key={fid}><span>{fname}</span>{platforms.map((pf) => {
        const cell = posts.filter((p) => p.format === fid && p.platform === pf && p.v24 !== null);
        if (!cell.length) return <div className="rc-hm-cell rc-hm-none" key={pf}><b>—</b><span>无内容</span></div>;
        const v = median(cell.map((p) => p.v24!));
        const a = 0.08 + 0.5 * Math.log10(v + 1) / Math.log10(maxV + 1);
        return <div className="rc-hm-cell" key={pf} style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)` }} onClick={() => onCell(pf, fid)}>
          <b>{fmtNum(v)}</b><span>{cell.length} 条 · 中位 24h 阅读</span>
        </div>;
      })}</div>)}
    </div>
    <div className="rc-legend"><span>颜色越深 = 该组合中位表现越强</span><span className="rc-legend-note">点击单元格 = 按该组合筛选</span></div>
  </>;
}

export const chartGeom = { W, H, M, HOURS };

// 单帖钻取:原位把图表区变换为该帖实测曲线,同期分位带淡化为背景
export function DrillView({ post, cohort, metricLabel, fieldStatusLabel, reviewBlock }: {
  post: PostView;
  cohort: PostView[];
  metricLabel: (key: string) => string;
  fieldStatusLabel: (status: string) => string;
  reviewBlock: React.ReactNode;
}): React.JSX.Element {
  const base = cohort.filter((p) => p.points.length >= 2);
  const xs = (h: number) => M.l + (Math.log10(h) / Math.log10(72)) * (W - M.l - M.r);
  const allV = [...base.flatMap((c) => c.points.map((pt) => pt.value)), ...post.points.map((pt) => pt.value)];
  const lo = Math.log10(Math.max(1, Math.min(...allV))), hi = Math.log10(Math.max(...allV));
  const ys = (v: number) => M.t + (1 - (Math.log10(Math.max(1, v)) - lo) / Math.max(0.01, hi - lo)) * (H - M.t - M.b);
  const q = (hours: number, qq: number) => {
    const s = base.map((c) => c.points.find((pt) => pt.hours === hours)?.value).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length * qq)] : 0;
  };
  const windows = HOURS.filter((h) => base.filter((c) => c.points.some((pt) => pt.hours === h)).length >= 2);
  const bandPath = (qa: number, qb: number) => {
    if (windows.length < 2) return '';
    const top = windows.map((h) => [xs(h), ys(q(h, qb))]);
    const bot = windows.map((h) => [xs(h), ys(q(h, qa))]).reverse();
    return `M${[...top, ...bot].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z`;
  };
  const color = platformColor(post.platform);
  const yTicks = yGrid(lo, hi);
  return <>
    <svg className="rc-chart" viewBox={`0 0 ${W} ${H}`}>
      {yTicks.map((v, i) => <g key={i}>
        <line className="rc-grid" x1={M.l} x2={W - M.r} y1={ys(v)} y2={ys(v)}/>
        <text x={M.l - 8} y={ys(v) + 3} textAnchor="end">{fmtNum(v)}</text>
      </g>)}
      <line className="rc-axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b}/>
      <line className="rc-axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b}/>
      {HOURS.map((h) => <text key={h} x={xs(h)} y={H - M.b + 18} textAnchor="middle">+{h}h</text>)}
      {windows.length >= 2 && <>
        <path d={bandPath(0.1, 0.9)} className="rc-band90 faint"/>
        <path d={bandPath(0.25, 0.75)} className="rc-band75 faint"/>
      </>}
      <polyline points={post.points.map((pt) => `${xs(pt.hours).toFixed(1)},${ys(pt.value).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth={2.4}/>
      {post.points.map((pt, i) => <g key={i}>
        <circle cx={xs(pt.hours)} cy={ys(pt.value)} r={3.6} style={{ fill: color }}/>
        <text x={xs(pt.hours)} y={ys(pt.value) - 9} textAnchor="middle" className="rc-vlabel">{fmtNum(pt.value)}</text>
      </g>)}
    </svg>
    <div className="rc-legend">
      <span><i style={{ background: color, height: '2.5px' }}/>该内容实测曲线</span>
      {windows.length >= 2 && <span><i className="rc-band-p75"/>同期 P25–P75 背景</span>}
      <span className="rc-legend-note">淡色带 = 当前筛选下全部内容的分布参照</span>
    </div>
    <div className="rc-drill-detail">
      <div>
        <p className="eyebrow rc-sec">指标快照 · 数据状态</p>
        {post.points.length ? <table className="rc-table"><thead><tr><th>窗口</th><th>实际采集</th>{Object.keys(post.points[0].snap.normalized).map((key) => <th key={key}>{metricLabel(key)}</th>)}<th>状态</th></tr></thead><tbody>
          {post.points.map((pt) => {
            const fields = Object.entries(pt.snap.normalized);
            const missing = fields.filter(([, f]) => f.status !== 'value').length;
            return <tr key={pt.snap.id}>
              <td>+{pt.hours}h</td>
              <td>{new Date(pt.snap.capturedAt).toLocaleString('zh-CN')}</td>
              {fields.map(([key, f]) => <td key={key}>{f.status === 'value' ? fmtNum(Number(f.value)) : fieldStatusLabel(f.status)}</td>)}
              <td>{missing === 0 ? <span className="rc-ok">全部有值</span> : <span className="rc-missing">{missing} 项不可见</span>}</td>
            </tr>;
          })}
        </tbody></table> : <div className="rc-empty">该内容还没有指标快照。</div>}
        {post.points.length > 0 && <p className="rc-src">来源 <span>{post.points[0].snap.sourceUrl || post.externalUrl || '未记录'}</span></p>}
      </div>
      <div>
        <p className="eyebrow rc-sec">复盘</p>
        {reviewBlock}
      </div>
    </div>
  </>;
}
