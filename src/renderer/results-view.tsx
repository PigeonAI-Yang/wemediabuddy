import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PiFocusObject } from './app-types';
import { formatNames, platformNames } from './app-types';
import { BandsChart, DrillView, Heatmap, ScatterChart, median } from './results-charts';
import type { MetricSnapshotRow, PostPoint, PostView } from './results-charts';
import { ActionsPanel, HeroPanel, PendingPanel } from './results-panels';
import type { ActionColumns, PatternCard } from './results-panels';
import { ResultsHealthPanel } from './results-health.tsx';
import { TodayYesterdayIteration } from './today-yesterday-iteration';

type IterationTarget = Record<string, unknown> & {
  id: string;
  target_kind: string;
  predecessor_publication_id?: string | null;
  predecessor_content_version_id?: string | null;
  status: string;
  project_id?: string | null;
  created_at?: string;
  updated_at?: string;
  revision?: number;
  counts_toward_goal?: number;
};
type YesterdayProjection = {
  cycle: Record<string, unknown> | null;
  draftIterations: IterationTarget[];
  publishedIterations: IterationTarget[];
};

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
const shortTargetId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

// WMB-1510 结果页 = 运营学习闭环驾驶舱:周期聚合优先,单帖钻取在图表区内原位完成
export function ResultsView({ publications, planDate, enabledPlatforms, onFocusChange, openStudio }: {
  publications: Publications;
  refresh: () => void;
  planDate: string;
  enabledPlatforms: Array<'x' | 'xiaohongshu' | 'wechat' | 'zhihu'>;
  onFocusChange?: (focus: PiFocusObject | null) => void;
  openStudio: (projectId?: string) => void;
}): React.JSX.Element {
  const published = (publications ?? []).filter((item) => item.publication.status === 'published' && item.publication.publishedAt);
  const pubKey = published.map((item) => item.publication.id).join(',');
  const [snapshots, setSnapshots] = useState<MetricSnapshotRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([]);
  const [period, setPeriod] = useState(() => {
    const requested = sessionStorage.getItem('wmb.resultsRange');
    sessionStorage.removeItem('wmb.resultsRange');
    return requested === '7d' ? 7 : 30;
  });
  const [pf, setPf] = useState('');
  const [fmt, setFmt] = useState('');
  const [tab, setTab] = useState<'scatter' | 'curve' | 'heat'>('scatter');
  const [chartMode, setChartMode] = useState<'abs' | 'norm'>('abs');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  // WMB-5334: nextBusinessDate is the iteration cycle date (次日) derived from planDate; fallback to tomorrow
  const nextBusinessDate = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(planDate));
    if (m) {
      const d = new Date(`${planDate}T00:00:00`);
      if (!Number.isNaN(d.getTime())) {
        d.setDate(d.getDate() + 1);
        return d.toISOString().slice(0, 10);
      }
    }
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
  }, [planDate]);
  const [iterLineage, setIterLineage] = useState<{ projectId: string; predecessorContentVersionId: string } | null>(null);
  const [iterLineageError, setIterLineageError] = useState('');
  const [iterLoading, setIterLoading] = useState(false);
  const [iterTarget, setIterTarget] = useState<Record<string, unknown> | null>(null);
  const [iterExistsBefore, setIterExistsBefore] = useState<boolean | null>(null);
  const [iterError, setIterError] = useState('');
  const [iterBusy, setIterBusy] = useState(false);
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
  const platforms = Object.keys(platformNames).filter((key) => posts.some((post) => post.platform === key));
  const formats = Object.entries(formatNames).filter(([key]) => posts.some((post) => post.format === key));

  const visible = posts.filter((p) => (period === 0 || p.daysAgo <= period) && (!pf || p.platform === pf) && (!fmt || p.format === fmt));
  const selected = posts.find((p) => p.id === selectedId) ?? null;
  const selectedReview = selected ? reviews.find((r) => r.publicationId === selected.id) ?? null : null;
  useEffect(() => {
    if (!onFocusChange) return;
    if (!selected) {
      onFocusChange(null);
      return;
    }
    const review = selectedReview;
    const latestPoint = selected.points[selected.points.length - 1];
    onFocusChange({
      type: 'publication',
      id: selected.id,
      title: selected.title,
      summary: [
        `${platformNames[selected.platform] ?? selected.platform}`,
        selected.format ? (formatNames[selected.format] ?? selected.format) : null,
        selected.v24 != null ? `24h主指标 ${selected.v24}` : null,
        selected.reviewed ? '已有复盘' : '未复盘'
      ].filter(Boolean).join(' · '),
      url: selected.externalUrl || null,
      meta: {
        platform: selected.platform,
        format: selected.format,
        publishedAt: selected.publishedAt,
        v24: selected.v24,
        latestMetric: latestPoint ? { hours: latestPoint.hours, value: latestPoint.value } : null,
        reviewStatus: review?.status ?? null,
        reviewSummary: review?.summary ?? null,
        keep: review?.keep ?? [],
        stop: review?.stop ?? [],
        change: review?.change ?? []
      }
    });
  }, [selected?.id, selected?.v24, selectedReview?.id, selectedReview?.status, onFocusChange]);

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

  const discuss = (prompt: string) => window.dispatchEvent(new CustomEvent('wmb-pi-generate', {
    detail: { prompt, orchestration: { originLabel: 'Results', title: '和 Pi 讨论本周期', goal: '基于本周期指标快照与复盘记录产出周期判断', acceptance: '3 条判断 + keep/stop/change 行动' } }
  }));
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

  // WMB-5334: resolve stable publication/content lineage for selected published result and check existing revision target
  useEffect(() => {
    if (!selected) {
      setIterLineage(null);
      setIterLineageError('');
      setIterTarget(null);
      setIterExistsBefore(null);
      setIterError('');
      setIterLoading(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setIterLoading(true);
      setIterLineageError('');
      setIterError('');
      setIterTarget(null);
      setIterExistsBefore(null);
      try {
        const pubEntry = publications.find((p) => p.publication.id === selected.id);
        if (!pubEntry) {
          if (!cancelled) setIterLineageError('未找到发布 lineage');
          return;
        }
        const projectId = pubEntry.publication.projectId;
        if (!projectId) {
          if (!cancelled) setIterLineageError('发布缺少项目关联');
          return;
        }
        let predecessorContentVersionId: string | null = null;
        try {
          const detail = await window.wmb.getStudioProject(projectId);
          if (detail && detail.platformVersions) {
            const pvMap = detail.platformVersions;
            const pvId = pubEntry.publication.platformVersionId;
            for (const arr of Object.values(pvMap)) {
              const found = arr.find((v) => v.id === pvId);
              if (found) { predecessorContentVersionId = found.contentVersionId; break; }
            }
            if (!predecessorContentVersionId) {
              const revs = detail.revisions;
              if (revs && revs.length) predecessorContentVersionId = revs[revs.length - 1]?.id ?? revs[0]?.id ?? null;
              else {
                const allPv = Object.values(pvMap).flat();
                if (allPv.length) predecessorContentVersionId = allPv[0]?.contentVersionId ?? null;
              }
            }
          }
        } catch {}
        if (!predecessorContentVersionId) {
          if (!cancelled) setIterLineageError('未能解析前置内容版本');
          return;
        }
        if (!cancelled) setIterLineage({ projectId, predecessorContentVersionId });
        try {
          const proj = await window.wmb.getYesterdayIteration(nextBusinessDate);
          if (cancelled) return;
          const arr = proj.publishedIterations ?? [];
          let existing: Record<string, unknown> | null = null;
          for (const t of arr) {
            if (typeof t !== 'object' || t === null) continue;
            const pid = t['predecessor_publication_id'];
            const cid = t['predecessor_content_version_id'];
            if (pid === selected.id || cid === predecessorContentVersionId) { existing = t; break; }
          }
          if (existing && typeof existing === 'object' && existing !== null && 'id' in existing) {
            setIterExistsBefore(true);
            setIterTarget(existing);
          } else {
            setIterExistsBefore(false);
            setIterTarget(null);
          }
        } catch (cause) {
          if (!cancelled) setIterError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setIterLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [selected?.id, publications, reviews, nextBusinessDate]);

  const joinNextIteration = useCallback(async () => {
    if (!selected || !iterLineage) return;
    if (busy || iterBusy) return;
    setIterBusy(true);
    setIterError('');
    try {
      const receipt = await window.wmb.ensurePublishedIteration({
        businessDate: nextBusinessDate,
        projectId: iterLineage.projectId,
        predecessorPublicationId: selected.id,
        predecessorContentVersionId: iterLineage.predecessorContentVersionId,
      });
      if (!receipt.ok) {
        const msg = receipt.error ? receipt.error.message : '加入次日迭代失败';
        throw new Error(msg);
      }
      const data = receipt.data;
      if (data && typeof data === 'object' && 'id' in data) {
        const target = data;
        setIterTarget(target);
        setIterExistsBefore(true);
        setStatusText(`已加入次日迭代 · 本地修订 ${shortTargetId(String(target['id']))} · ${nextBusinessDate}（本地修订不改变线上发布）`);
      } else {
        const proj = await window.wmb.getYesterdayIteration(nextBusinessDate);
        const arr = proj.publishedIterations ?? [];
        let found: Record<string, unknown> | null = null;
        for (const t of arr) {
          if (typeof t === 'object' && t !== null && 'predecessor_publication_id' in t && t['predecessor_publication_id'] === selected.id) { found = t; break; }
        }
        if (found && typeof found === 'object' && found !== null && 'id' in found) {
          setIterTarget(found);
          setIterExistsBefore(true);
          setStatusText(`已加入次日迭代 · ${nextBusinessDate}（本地修订不改变线上发布）`);
        } else {
          setStatusText(`已加入次日迭代 · ${nextBusinessDate}（本地修订不改变线上发布）`);
        }
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      setIterError(msg);
      setStatusText(msg);
    } finally {
      setIterBusy(false);
    }
  }, [selected?.id, iterLineage, nextBusinessDate, busy, iterBusy]);
  const reviewedCount = visible.filter((p) => p.reviewed).length;
  const resultsActionLine = pending.length
    ? `本周期 ${visible.length} 条已发布，${reviewedCount} 条已复盘；${pending.length} 条发布超过 72h 待复盘，见底部待复盘队列。`
    : `本周期 ${visible.length} 条已发布，${reviewedCount} 条已复盘，没有遗留待复盘。`;
  const stats: Array<[string, string]> = [
    [String(visible.length), '本周期发布'],
    [String(reviewedCount), '已复盘'],
    [String(findingCount), '方法库结论'],
    [String(new Set(backlinks.map((b) => b.planItemId)).size), '结论被方案引用'],
    [String(pending.length), '待复盘']
  ];
  return <section className="workflow-page results-page rl-page">
    {statusText && <p className="task-status" data-running={busy ? 'true' : 'false'}>{statusText}</p>}
    {!posts.length && <section className="empty-state"><h2>还没有可复盘内容</h2><p>取得真实发布地址后，这里会形成组合形态与复盘。</p></section>}
      <section className="rl-panel rl-review-panel" aria-label="复盘" data-testid="results-review">
        <div className="rl-review-head">
          <h2 className="rl-review-title">复盘</h2>
          <span className="rl-review-note">昨日迭代 · 按业务日期聚合，可刷新并返回对应创作项目</span>
        </div>
        <TodayYesterdayIteration businessDate={planDate} openStudio={openStudio} />
      </section>
    {posts.length > 0 && <>
      <section className="page-command" aria-label="结果复盘概览">
        <div className="page-command-main">
          <div className="page-command-copy">
            <div className="page-command-title-row">
              <h1>结果</h1>
              <p>{resultsActionLine}</p>
            </div>
            <div className="page-command-stats" aria-label="复盘指标">
              {stats.map(([v, label], i) => (
                <div className="page-command-stat" key={label}>
                  <strong style={i === 4 && Number(v) > 0 ? { color: 'var(--amber)' } : i === 3 ? { color: 'var(--accent-soft)' } : undefined}>{v}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
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
      <section className="rl-panel rl-iteration-panel" aria-label="加入次日迭代" data-testid="results-iteration-panel">
        <div className="rl-iteration-head">
          <h3>加入次日迭代</h3>
          <span className="rl-iteration-date" aria-label="次日业务日期">{nextBusinessDate}</span>
        </div>
        <p className="rl-iteration-note">已发布内容的 Change 项可加入次日迭代，生成本地修订版本；<strong>本地修订不改变线上发布</strong>，不触发线上更新，不占用每日 2 条。</p>
        {!selected ? (
          <p className="rl-iteration-hint">请选择一条已发布内容查看其迭代状态</p>
        ) : iterLoading ? (
          <p className="rl-iteration-msg" role="status">正在解析发布 lineage 与次日迭代目标…</p>
        ) : iterLineageError ? (
          <p className="rl-iteration-error" role="alert"> lineage 解析失败：{iterLineageError}</p>
        ) : (
          <div className="rl-iteration-body">
            <div className="rl-iteration-lineage" aria-label="稳定 lineage">
              <span className="rl-iteration-lineage-label">稳定 lineage</span>
              <span className="rl-iteration-lineage-value" title={iterLineage?.projectId}>项目 {shortTargetId(iterLineage?.projectId ?? '')}</span>
              <span className="rl-iteration-sep">·</span>
              <span className="rl-iteration-lineage-value" title={iterLineage?.predecessorContentVersionId}>内容版本 {shortTargetId(iterLineage?.predecessorContentVersionId ?? '')}</span>
              <span className="rl-iteration-sep">·</span>
              <span className="rl-iteration-lineage-value">发布 {shortTargetId(selected.id)}</span>
            </div>
            <div className="rl-iteration-status" role="status" aria-live="polite">
              {iterExistsBefore === true && iterTarget ? (
                <span className="rl-iteration-exists">已存在本地修订目标 · <span className="rl-iteration-target-id">{shortTargetId(String(iterTarget.id))}</span> · 状态 <span className="rl-iteration-target-status">{String(iterTarget.status)}</span></span>
              ) : iterExistsBefore === false ? (
                <span className="rl-iteration-none">暂无本地修订目标 · 点击下方按钮创建</span>
              ) : null}
            </div>
            {iterTarget && (
              <div className="rl-iteration-target-detail" aria-label="本地修订详情">
                <div className="rl-iteration-target-row"><span className="rl-iteration-target-label">本地修订目标</span><span className="rl-iteration-target-value">{String(iterTarget.id)}</span></div>
                <div className="rl-iteration-target-row"><span className="rl-iteration-target-label">状态</span><span className="rl-iteration-target-value">{String(iterTarget.status)}</span>{typeof iterTarget.revision === 'number' && <span className="rl-iteration-target-revision"> · revision {String(iterTarget.revision)}</span>}</div>
                <div className="rl-iteration-online-local" aria-label="线上与本地分离">
                  <span className="rl-iteration-online">线上发布 <span className="rl-iteration-online-url">{selected.externalUrl || '—'}</span> 保持不变</span>
                  <span className="rl-iteration-arrow" aria-hidden>→</span>
                  <span className="rl-iteration-local">本地修订 <span className="rl-iteration-local-id">{shortTargetId(String(iterTarget.id))}</span> 仅在工作室追加新版本</span>
                </div>
                <p className="rl-iteration-separation"><strong>本地修订不改变线上发布</strong> · 需在工作室完成新版本后另行走线上发布流程</p>
              </div>
            )}
            {!iterTarget && iterExistsBefore === false && (
              <p className="rl-iteration-separation rl-iteration-separation--pending"><strong>本地修订不改变线上发布</strong> · 创建后将在工作室追加新版本，线上内容保持不变</p>
            )}
            {iterError && <p className="rl-iteration-error" role="alert">{iterError}</p>}
            <div className="rl-iteration-actions">
              <button
                type="button"
                className="primary-button rl-iteration-primary"
                disabled={!iterLineage || iterBusy || busy}
                onClick={() => void joinNextIteration()}
                aria-label={iterExistsBefore ? '再次加入次日迭代（幂等复用）' : '加入次日迭代'}
                data-testid="results-join-iteration"
              >
                {iterBusy ? '正在加入…' : iterExistsBefore ? '再次加入次日迭代（幂等）' : '加入次日迭代'}
              </button>
              <span className="rl-iteration-meta">次日 {nextBusinessDate} · 已发布修订不计入 2 条目标</span>
            </div>
            <p className="rl-iteration-hint-small">重复点击复用同一本地目标（幂等），不会重复创建或改动线上发布</p>
          </div>
        )}
      </section>
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
            <section className="rl-drill-iteration" aria-label="已发布内容次日迭代" data-testid="results-drill-iteration">
              <div className="rl-drill-iteration-head">
                <h4>已发布内容 · 次日迭代</h4>
                <span className="rl-drill-iteration-date">{nextBusinessDate}</span>
              </div>
              <p className="rl-drill-iteration-note"><strong>本地修订不改变线上发布</strong> · Change 可生成本地修订目标，线上内容保持不变，不计入每日 2 条</p>
              {iterLoading ? (
                <p className="rl-drill-iteration-msg" role="status">正在检查次日迭代目标…</p>
              ) : iterLineageError ? (
                <p className="rl-drill-iteration-error" role="alert">{iterLineageError}</p>
              ) : (
                <>
                  <div className="rl-drill-iteration-status" role="status">
                    {iterExistsBefore === true && iterTarget ? (
                      <span>已存在本地修订 · {shortTargetId(String(iterTarget.id))} · {String(iterTarget.status)}</span>
                    ) : iterExistsBefore === false ? (
                      <span>暂无本地修订 · 可创建次日迭代目标</span>
                    ) : null}
                  </div>
                  {iterTarget && (
                    <div className="rl-drill-iteration-detail">
                      <span className="rl-drill-iteration-target">本地目标 {shortTargetId(String(iterTarget.id))}</span>
                      <span className="rl-drill-iteration-sep">·</span>
                      <span>线上发布 {selected.externalUrl ? selected.externalUrl.slice(0, 32) : '—'} 保持不变</span>
                    </div>
                  )}
                  {iterError && <p className="rl-iteration-error" role="alert">{iterError}</p>}
                  <button
                    type="button"
                    className="secondary-button rl-drill-iteration-action"
                    disabled={!iterLineage || iterBusy || busy}
                    onClick={() => void joinNextIteration()}
                    aria-label={iterExistsBefore ? '再次加入次日迭代（幂等）' : '加入次日迭代'}
                    data-testid="results-drill-join-iteration"
                  >
                    {iterBusy ? '正在加入…' : iterExistsBefore ? '再次加入次日迭代（幂等）' : '加入次日迭代'}
                  </button>
                </>
              )}
            </section>
          </> : tab === 'heat'
            ? <Heatmap posts={visible} formats={formats} platformNames={Object.fromEntries(platforms.map((k) => [k, platformNames[k]]))} onCell={(platform, format) => { setPf(platform); setFmt(format); setTab('scatter'); }}/>
            : tab === 'curve'
              ? <BandsChart posts={visible} mode={chartMode} onMode={setChartMode} onSelect={(post) => setSelectedId(post.id)}/>
              : <ScatterChart posts={visible} onSelect={(post) => setSelectedId(post.id)}/>}
        </section>
      </div>
      <ActionsPanel columns={actionColumns}/>
      <ResultsHealthPanel publications={posts} reviews={reviews} snapshots={snapshots} onOpenPublication={(publicationId) => setSelectedId(publicationId)}/>
      <PendingPanel posts={pending} busy={busy} onOpen={(post) => setSelectedId(post.id)} onReviewOne={(post) => void reviewOne(post)} onReviewAll={() => void reviewAll()}/>
    </>}
  </section>;
}
