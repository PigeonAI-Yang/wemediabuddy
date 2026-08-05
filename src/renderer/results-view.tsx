import { useEffect, useMemo, useState } from 'react';
import { formatNames, platformNames } from './app-types';
import { BandsChart, DrillView, Heatmap, ScatterChart, median } from './results-charts';
import type { MetricSnapshotRow, PostPoint, PostView } from './results-charts';
import { ActionsPanel, HeroPanel, PendingPanel } from './results-panels';
import type { ActionColumns, PatternCard } from './results-panels';

type ReviewRow = Awaited<ReturnType<typeof window.wmb.listReviews>>[number];
type BacklinkRow = Awaited<ReturnType<typeof window.wmb.listReviewBacklinks>>[number];
type Publications = Awaited<ReturnType<typeof window.wmb.getPublications>>;

const WINDOWS = [1, 6, 24, 72];
const metricLabels: Record<string, string> = { views: '阅读', reads: '阅读', plays: '播放', likes: '点赞', bookmarks: '收藏', favorites: '收藏', replies: '评论', comments: '评论', reposts: '转发', shares: '分享', followers: '粉丝', wow: '在看' };
const metricLabel = (key: string) => metricLabels[key] ?? key;
const fieldStatusLabel = (status: string) => ({ unsupported: '平台不支持', unavailable: '暂不可见', parse_failed: '解析失败' } as Record<string, string>)[status] ?? status;
const primaryValue = (snap: MetricSnapshotRow): number | null => {
  for (const key of ['views', 'reads', 'plays']) if (snap.normalized[key]?.status === 'value') return Number(snap.normalized[key].value);
  const first = Object.values(snap.normalized).find((f) => f.status === 'value');
  return first ? Number(first.value) : null;
};
const nearestWindow = (hours: number) => WINDOWS.reduce((a, b) =>
  Math.abs(Math.log10(Math.max(0.4, hours)) - Math.log10(a)) < Math.abs(Math.log10(Math.max(0.4, hours)) - Math.log10(b)) ? a : b);
const stripQuotes = (title: string) => title.replace(/^[《「『\[]+|[》」』\]]+$/g, '');

// WMB-1510 结果页 = 运营学习闭环驾驶舱:周期聚合优先,单帖钻取在图表区内原位完成
export function ResultsView({ publications, planDate, enabledPlatforms }: {
  publications: Publications;
  refresh: () => void;
  planDate: string;
  enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat'>;
}): React.JSX.Element {
  const published = (publications ?? []).filter((item) => item.publication.status === 'published' && item.publication.publishedAt);
  const [snapshots, setSnapshots] = useState<MetricSnapshotRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([]);
  const [period, setPeriod] = useState(30);
  const [pf, setPf] = useState('');
  const [fmt, setFmt] = useState('');
  const [tab, setTab] = useState<'scatter' | 'curve' | 'heat'>('scatter');
  const [chartMode, setChartMode] = useState<'abs' | 'norm'>('abs');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const pubKey = published.map((item) => item.publication.id).join(',');
  const reload = async () => {
    const [snaps, revs] = await Promise.all([window.wmb.listPublicationMetricSnapshots(), window.wmb.listReviews()]);
    setSnapshots(snaps as MetricSnapshotRow[]);
    setReviews(revs);
    setBacklinks(await window.wmb.listReviewBacklinks({
      reviewIds: revs.map((r) => r.id),
      findingIds: revs.flatMap((r) => r.findings.map((f) => f.id))
    }));
  };
  useEffect(() => { void reload(); }, [pubKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const posts = useMemo<PostView[]>(() => {
    const snapByPub = new Map<string, MetricSnapshotRow[]>();
    for (const snap of snapshots) {
      const arr = snapByPub.get(snap.publicationId) ?? [];
      arr.push(snap);
      snapByPub.set(snap.publicationId, arr);
    }
    const reviewByPub = new Map(reviews.map((r) => [r.publicationId, r]));
    return published.map((item) => {
      const pub = item.publication;
      const publishedMs = Date.parse(pub.publishedAt!);
      const daysAgo = Math.max(0, (Date.now() - publishedMs) / 86_400_000);
      const buckets = new Map<number, MetricSnapshotRow>();
      for (const snap of snapByPub.get(pub.id) ?? []) {
        const hours = (Date.parse(snap.scheduledFor) - publishedMs) / 3_600_000;
        if (!Number.isFinite(hours) || hours < 0) continue;
        const bucket = nearestWindow(hours);
        const existing = buckets.get(bucket);
        if (!existing || existing.capturedAt < snap.capturedAt) buckets.set(bucket, snap);
      }
      const points = [...buckets.entries()]
        .map(([hours, snap]) => ({ hours, value: primaryValue(snap), snap }))
        .filter((pt): pt is PostPoint => pt.value !== null)
        .sort((a, b) => a.hours - b.hours);
      const v24 = buckets.has(24) ? primaryValue(buckets.get(24)!) : points.length ? points[points.length - 1].value : null;
      return {
        id: pub.id,
        title: stripQuotes(item.payload?.title || item.payload?.body.slice(0, 42) || '已发布内容'),
        platform: pub.platform, format: pub.format ?? '',
        publishedAt: pub.publishedAt!, externalUrl: pub.externalUrl ?? '',
        daysAgo, hour: new Date(publishedMs).getHours(), points, v24,
        reviewed: reviewByPub.has(pub.id)
      };
    });
  }, [pubKey, snapshots, reviews]);

  const visible = posts.filter((p) => (period === 0 || p.daysAgo <= period) && (!pf || p.platform === pf) && (!fmt || p.format === fmt));
  const selected = posts.find((p) => p.id === selectedId) ?? null;
  const selectedReview = selected ? reviews.find((r) => r.publicationId === selected.id) ?? null : null;

  const withV24 = visible.filter((p) => p.v24 !== null);
  const medianV24 = median(withV24.map((p) => p.v24!));
  const best = withV24.length ? [...withV24].sort((a, b) => b.v24! - a.v24!)[0] : null;
  const ratioOf = (a: PostView[], b: PostView[]): number | null => {
    const av = a.map((p) => p.v24).filter((v): v is number => v !== null);
    const bv = b.map((p) => p.v24).filter((v): v is number => v !== null);
    if (av.length < 4 || bv.length < 4) return null;
    return median(av) / Math.max(1, median(bv));
  };
  const night = visible.filter((p) => p.hour >= 20 && p.hour <= 23);
  const videos = visible.filter((p) => p.format === 'video' || p.format === 'short_video');
  const xhs = visible.filter((p) => p.platform === 'xiaohongshu');
  const nightRatio = ratioOf(night, visible.filter((p) => !(p.hour >= 20 && p.hour <= 23)));
  const videoRatio = ratioOf(videos, visible.filter((p) => !videos.includes(p)));
  const xhsRatio = ratioOf(xhs, visible.filter((p) => p.platform === 'x'));
  const patterns: PatternCard[] = [
    { title: '晚间 20–23 点发布 → 24h 阅读更高', ratio: nightRatio, desc: '20:00–23:00 发布的内容，24h 阅读中位数对比其他时段。', evidence: night.length, ok: nightRatio !== null && nightRatio > 1.2, prompt: `请读取指标快照数据,核验这个模式是否成立:晚间 20-23 点发布的内容 24h 阅读更高(本期倍数 ${nightRatio?.toFixed(1) ?? '未知'}×,证据 ${night.length} 帖)。给出判断,必要时在下次复盘定稿时固化为方法结论。` },
    { title: '视频形式 → 阅读体量更大', ratio: videoRatio, desc: '视频/口播内容的 24h 阅读中位数对比图文与文字。', evidence: videos.length, ok: videoRatio !== null && videoRatio > 1.2, prompt: `请读取指标快照数据,核验视频形式是否带来更大阅读体量(本期倍数 ${videoRatio?.toFixed(1) ?? '未知'}×,证据 ${videos.length} 帖),同时评估其收藏率是否同步成立。` },
    ...(enabledPlatforms.includes('xiaohongshu') && enabledPlatforms.includes('x') ? [{ title: '小红书 → 收藏型资产平台', ratio: xhsRatio, desc: '小红书内容的 24h 阅读中位数对比 X。', evidence: xhs.length, ok: xhsRatio !== null && xhsRatio > 1.2, prompt: `请读取指标快照数据,对比小红书与 X 的内容表现(本期阅读中位倍数 ${xhsRatio?.toFixed(1) ?? '未知'}×,证据 ${xhs.length} 帖),判断平台精力分配是否需要调整。` }] : [])
  ];

  const visibleIds = new Set(visible.map((p) => p.id));
  const visibleReviews = reviews.filter((r) => visibleIds.has(r.publicationId));
  const actionColumns = useMemo<ActionColumns>(() => {
    const agg = { keep: new Map<string, Set<string>>(), stop: new Map<string, Set<string>>(), change: new Map<string, Set<string>>() };
    for (const review of visibleReviews) {
      for (const key of ['keep', 'stop', 'change'] as const) {
        for (const txt of review[key]) {
          const set = agg[key].get(txt) ?? new Set<string>();
          set.add(review.id);
          agg[key].set(txt, set);
        }
      }
    }
    const top = (map: Map<string, Set<string>>) => [...map.entries()]
      .map(([txt, reviewIds]) => ({
        txt, count: reviewIds.size,
        adopted: new Set(backlinks.filter((b) => b.reviewIds.some((id) => reviewIds.has(id))).map((b) => b.planItemId)).size
      }))
      .sort((a, b) => b.count - a.count).slice(0, 4);
    return { keep: top(agg.keep), stop: top(agg.stop), change: top(agg.change) };
  }, [pubKey, period, pf, fmt, reviews, backlinks]);
  const findingCount = reviews.reduce((s, r) => s + r.findings.length, 0);
  const pending = posts.filter((p) => p.daysAgo >= 3 && !p.reviewed).sort((a, b) => (b.v24 ?? 0) - (a.v24 ?? 0));

  const discuss = (prompt: string) => window.dispatchEvent(new CustomEvent('wmb-pi-generate', { detail: prompt }));
  const reviewOne = async (post: PostView) => {
    if (busy) return;
    if (!post.points.length) { setStatusText('没有指标快照时不能让 Pi 做数据驱动复盘。'); return; }
    setBusy(true);
    setStatusText(`Pi 正在复盘《${post.title}》…`);
    try {
      const result = await window.wmb.startResultsReview({ businessDate: planDate, publicationId: post.id });
      if (!result.ok) throw new Error(result.error?.message || 'Pi 复盘失败');
      if (result.data?.task.status === 'needs_user') { setStatusText(result.data.task.errorMessage || '需要用户处理'); return; }
      await reload();
      setStatusText('Pi 复盘已完成');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const reviewAll = async () => {
    if (busy || !pending.length) return;
    setBusy(true);
    let done = 0;
    for (const post of pending) {
      if (!post.points.length) continue;
      setStatusText(`Pi 正在批量复盘 ${done + 1}/${pending.length}：《${post.title}》…`);
      try {
        const result = await window.wmb.startResultsReview({ businessDate: planDate, publicationId: post.id });
        if (result.ok && result.data?.task.status === 'succeeded') done += 1;
      } catch { /* 单条失败不阻塞批量 */ }
    }
    await reload();
    setStatusText(`批量复盘完成：${done} 条已生成`);
    setBusy(false);
  };

  const platforms = Object.keys(platformNames).filter((key) => posts.some((p) => p.platform === key));
  const formats = Object.entries(formatNames).filter(([key]) => posts.some((p) => p.format === key));
  const reviewedCount = visible.filter((p) => p.reviewed).length;
  // 页面级行动句：先回答「结果说明什么、什么需要我做」。
  const resultsActionLine = pending.length
    ? `本周期 ${visible.length} 条已发布，${reviewedCount} 条已复盘；${pending.length} 条发布超过 72h 待复盘，见底部待复盘队列。`
    : `本周期 ${visible.length} 条已发布，${reviewedCount} 条已复盘，没有遗留待复盘。`;
  const stats = [
    [String(visible.length), '本周期发布'],
    [String(reviewedCount), '已复盘'],
    [String(findingCount), '方法库结论'],
    [String(new Set(backlinks.map((b) => b.planItemId)).size), '结论被方案引用'],
    [String(pending.length), '待复盘']
  ];
  return <section className="workflow-page results-page rl-page">
    {statusText && <p className="task-status" data-running={busy ? 'true' : 'false'}>{statusText}</p>}
    {!posts.length && <section className="empty-state"><h2>还没有可复盘内容</h2><p>取得真实发布地址后，这里会形成组合形态与复盘。</p></section>}
    {posts.length > 0 && <>
      <p className="rl-action-line">{resultsActionLine}</p>
      <div className="rl-stats">{stats.map(([v, label], i) => <div className="rl-stat" key={label}>
        <b className="num" style={i === 4 && Number(v) > 0 ? { color: 'var(--amber)' } : i === 3 ? { color: 'var(--accent-soft)' } : undefined}>{v}</b><span>{label}</span>
      </div>)}</div>
      <div className="rl-filters">
        <div className="rl-chip-group"><span>周期</span>{[[7, '近 7 天'], [30, '近 30 天'], [0, '全部']].map(([d, label]) =>
          <button key={d} className={`chip${period === d ? ' on' : ''}`} onClick={() => { setPeriod(d as number); setSelectedId(null); }}>{label}</button>)}</div>
        <div className="rl-chip-group"><span>平台</span><button className={`chip${pf === '' ? ' on' : ''}`} onClick={() => { setPf(''); setSelectedId(null); }}>全部</button>
          {platforms.map((key) => <button key={key} className={`chip${pf === key ? ' on' : ''}`} onClick={() => { setPf(key); setSelectedId(null); }}>{platformNames[key]}</button>)}</div>
        <div className="rl-chip-group"><span>形式</span><button className={`chip${fmt === '' ? ' on' : ''}`} onClick={() => { setFmt(''); setSelectedId(null); }}>全部</button>
          {formats.map(([key, label]) => <button key={key} className={`chip${fmt === key ? ' on' : ''}`} onClick={() => { setFmt(key); setSelectedId(null); }}>{label}</button>)}</div>
      </div>
      <HeroPanel
        total={visible.length} reviewed={reviewedCount} pending={pending.length}
        best={best} medianV24={medianV24}
        topPattern={patterns.filter((p) => p.ratio !== null).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0] ?? null}
        topActions={{ keep: actionColumns.keep[0]?.txt, stop: actionColumns.stop[0]?.txt, change: actionColumns.change[0]?.txt }}
        onDiscuss={() => discuss('请读取本周期已发布内容的指标快照与复盘记录,给出周期复盘草案:3 个最值得记住的判断,以及 keep/stop/change 各一条具体行动。')}
      />
      <div className="rl-grid">
        <section className="rl-panel rl-chart-panel">
          <div className="rl-panel-head rl-chart-head">
            {selected
              ? <button className="mini-btn" onClick={() => setSelectedId(null)}>← 返回总览</button>
              : <div className="rl-tabs">{([['scatter', '表现散点'], ['curve', '增长形态'], ['heat', '形式 × 平台热图']] as const).map(([key, label]) =>
                  <button key={key} className={tab === key ? 'on' : ''} onClick={() => { setTab(key); setSelectedId(null); }}>{label}</button>)}</div>}
          </div>
          {selected ? <>
            <div className="rl-drill-head">
              <b>《{selected.title}》</b>
              <span>{platformNames[selected.platform]} · {formatNames[selected.format] ?? (selected.format || '未知形式')} · {Math.floor(selected.daysAgo)} 天前 {String(selected.hour).padStart(2, '0')}:00 发布</span>
            </div>
            <DrillView post={selected} cohort={visible} metricLabel={metricLabel} fieldStatusLabel={fieldStatusLabel} reviewBlock={
              selectedReview && selectedReview.status === 'final' ? <div className="rl-ksc">
                {selectedReview.summary && <p className="rl-ksc-summary">{selectedReview.summary}</p>}
                <div className="row k"><b>✓ 保留</b><span>{selectedReview.keep.join('；') || '—'}</span></div>
                <div className="row s"><b>✕ 停止</b><span>{selectedReview.stop.join('；') || '—'}</span></div>
                <div className="row c"><b>↻ 改变</b><span>{selectedReview.change.join('；') || '—'}</span></div>
              </div> : <div className="rl-empty-note">
                {selectedReview ? '这份复盘还是草稿，定稿后结论才会进入方法库。' : '这条内容还没有复盘。'}
                <br/><br/>
                <button className="primary-button" disabled={busy || !selected.points.length} onClick={() => void reviewOne(selected)}>让 Pi 复盘</button>
                {!selected.points.length && <p className="rl-hint">没有指标快照时不能做数据驱动复盘。</p>}
              </div>
            }/>
          </> : tab === 'heat'
            ? <Heatmap posts={visible} formats={formats} platformNames={Object.fromEntries(platforms.map((k) => [k, platformNames[k]]))} onCell={(platform, format) => { setPf(platform); setFmt(format); setTab('scatter'); }}/>
            : tab === 'curve'
              ? <BandsChart posts={visible} mode={chartMode} onMode={setChartMode} onSelect={(post) => setSelectedId(post.id)}/>
              : <ScatterChart posts={visible} onSelect={(post) => setSelectedId(post.id)}/>}
        </section>
      </div>
      <ActionsPanel columns={actionColumns}/>
      <PendingPanel posts={pending} busy={busy} onOpen={(post) => setSelectedId(post.id)} onReviewOne={(post) => void reviewOne(post)} onReviewAll={() => void reviewAll()}/>
    </>}
  </section>;
}
