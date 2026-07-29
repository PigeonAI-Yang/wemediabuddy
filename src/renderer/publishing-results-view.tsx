import { useEffect, useMemo, useState } from 'react';
import { platformNames } from './app-types';
export function PublishView({ publications, refresh, openStudio, takeover, selectedId, onSelect }: {
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  refresh: () => void;
  openStudio: () => void;
  takeover: () => void;
  selectedId: string | null;
  onSelect: (publicationId: string) => void;
}): React.JSX.Element {
  const [articleUrl, setArticleUrl] = useState('');
  const selected = publications.find((item) => item.publication.id === selectedId) ?? publications[0] ?? null;
  useEffect(() => { if (selected && selected.publication.id !== selectedId) onSelect(selected.publication.id); }, [selected?.publication.id]);
  const publication = selected?.publication;
  const reconcile = async () => {
    if (!publication) return;
    const reconciled = await window.wmb.reconcileNotPublished(publication.id, publication.revision);
    if (!reconciled.ok) return;
    refresh();
  };
  const readBackWechat = async () => {
    if (!publication || !articleUrl.trim()) return;
    const result = await window.wmb.readBackWechatPublication(publication.id, publication.revision, articleUrl.trim());
    if (result.ok) {
      setArticleUrl('');
      refresh();
    }
  };
  return <section className="workflow-page">
    <header className="page-heading"><div><span>发布工作区</span><h1>确认你真正要发布的内容</h1><p>平台、账号、内容版本和素材必须在一次确认中完全一致。</p></div></header>
    <div className="publish-layout">
      <aside className="workflow-list"><div className="section-heading"><h2>发布任务</h2><span>{publications.length}</span></div>{publications.length ? <div className="publication-list">{publications.map((item) => <button className={item.publication.id === publication?.id ? 'active' : ''} key={item.publication.id} onClick={() => onSelect(item.publication.id)}><strong>{item.payload?.title || item.payload?.body.slice(0, 42) || '尚未准备内容'}</strong><span>{platformNames[item.publication.platform]} · {publicationStatus(item.publication.status)}</span></button>)}</div> : <div className="compact-empty"><h2>还没有发布任务</h2><p>从创作页准备平台版本后会出现在这里。</p><button onClick={openStudio}>回到创作</button></div>}</aside>
      <main className="publish-preview">{selected?.payload ? <article className={`final-preview${publication?.status === 'awaiting_confirmation' ? ' awaiting' : ''}`}><div className="pub-identity"><span className={`pf-tag ${publication?.platform}`}><i>{platformIcon(publication?.platform)}</i>{platformNames[publication?.platform ?? ''] ?? publication?.platform}</span><span className="section-label">最终内容预览</span>{publication?.status === 'awaiting_confirmation' && <span className="pill-status amber"><span className="dot"/>等待你确认</span>}{publication?.status === 'published' && <span className="pill-status green"><span className="dot"/>已发布</span>}</div>{selected.payload.title && <h2>{selected.payload.title}</h2>}<div className="pub-payload">{selected.payload.body}</div>{selected.payload.assets.length > 0 && <div className="pub-assets">{selected.payload.assets.map((asset) => <div className="asset-thumb" key={asset.id}><span>{asset.mimeType}</span><span className="num">SHA {asset.sha256.slice(0, 4)}…</span></div>)}</div>}<div className="asset-summary">媒体素材 {selected.payload.assets.length} 项</div><section className="timeline"><h3>状态时间线</h3>{selected.events.map((event, index) => <div className="tl-item" key={index}><span className={`tl-dot ${timelineDot(String(event.to_status))}`}/><div className="tl-text"><b>{publicationStatus(String(event.to_status))}</b><span className="faint">{event.created_at ? `${new Date(String(event.created_at)).toLocaleString('zh-CN')} · ` : ''}{String(event.reason || '')}</span></div></div>)}</section></article> : <div className="preview-placeholder"><span>最终内容预览</span><h2>尚未取得编辑器回读</h2><p>准备完成后，这里会原样显示标题、正文和媒体素材。</p></div>}</main>
      <aside className="confirmation-panel" data-state={publication?.status ?? 'none'}><div className="pub-identity"><span className="section-label">人工发布</span>{publication && <span className={`pf-tag ${publication.platform}`}><i>{platformIcon(publication.platform)}</i>{platformNames[publication.platform]}</span>}</div><h2>{publication ? publicationStatus(publication.status) : '发布信息尚未就绪'}</h2><dl className="confirmation-list"><dt>平台</dt><dd>{publication ? platformNames[publication.platform] : '未选择'}</dd><dt>账号</dt><dd>{publication?.accountKey || '未识别'}</dd><dt>内容状态</dt><dd>{selected?.payload ? '已准备' : '未绑定'}</dd><dt>媒体素材</dt><dd>{selected?.payload ? `${selected.payload.assets.length} 项` : '未绑定'}</dd></dl><p className="notice">{publication?.platform === 'xiaohongshu' ? '小红书 AI 操作只通过指定 MCP；请在小红书客户端中人工发布。' : 'WMB 不会点击平台的最终发布按钮。请在专用浏览器核对内容并手动发布。'}</p>{publication?.status === 'awaiting_confirmation' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器，人工发布</button>}{publication?.status === 'needs_user' && publication.platform !== 'xiaohongshu' && <button className="primary-button" onClick={takeover}>打开浏览器接管</button>}{publication?.platform === 'wechat' && ['awaiting_confirmation', 'needs_user', 'unknown'].includes(publication.status) && <div className="readback-form"><input value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="粘贴已发布的公众号文章链接"/><button className="secondary-button full-button" disabled={!articleUrl.trim()} onClick={readBackWechat}>核对文章并记录结果</button></div>}{publication?.status === 'unknown' && publication.platform !== 'wechat' && <button className="secondary-button full-button" onClick={reconcile}>我已核对，确认未发布</button>}</aside>
    </div>
  </section>;
}

export function ResultsView({ publications, refresh, planDate }: {
  publications: Awaited<ReturnType<typeof window.wmb.getPublications>>;
  refresh: () => void;
  planDate: string;
}): React.JSX.Element {
  type ReviewRow = Awaited<ReturnType<typeof window.wmb.listReviews>>[number];
  type BacklinkRow = Awaited<ReturnType<typeof window.wmb.listReviewBacklinks>>[number];
  const published = (publications ?? []).filter((item) => item.publication.status === 'published' && item.publication);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Array<{
    id: string; publicationId: string; scheduledFor: string; capturedAt: string; sourceUrl: string;
    normalized: Record<string, { status: string; value?: number; rawLabel?: string }>;
    raw: Record<string, { status: string; value?: number; rawLabel?: string }>;
  }>>([]);
  const [accountSnapshots, setAccountSnapshots] = useState<Array<{
    id: string; accountId: string; platform: string; capturedAt: string; sourceUrl: string;
    normalized: Record<string, { status?: string; value?: number; rawLabel?: string }>;
    raw: Record<string, { status?: string; value?: number; rawLabel?: string }>;
  }>>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [backlinks, setBacklinks] = useState<BacklinkRow[]>([]);
  const [keepText, setKeepText] = useState('');
  const [stopText, setStopText] = useState('');
  const [changeText, setChangeText] = useState('');
  const [findingTitle, setFindingTitle] = useState('');
  const [findingBody, setFindingBody] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const selected = published.find((item) => item.publication.id === selectedId) ?? published[0] ?? null;
  const activeReview = reviews[0] ?? null;
  useEffect(() => {
    if (selected && selected.publication.id !== selectedId) setSelectedId(selected.publication.id);
  }, [selected?.publication.id]);
  const loadPublicationContext = async (publicationId: string | null) => {
    if (!publicationId) {
      setSnapshots([]);
      setReviews([]);
      setBacklinks([]);
      return;
    }
    const [pubSnaps, acctSnaps, listedReviews] = await Promise.all([
      window.wmb.listPublicationMetricSnapshots(publicationId),
      window.wmb.listAccountMetricSnapshots(),
      window.wmb.listReviews(publicationId)
    ]);
    setSnapshots(pubSnaps);
    setAccountSnapshots(acctSnaps);
    setReviews(listedReviews);
    const current = listedReviews[0];
    if (current) {
      setKeepText(current.keep.join('\n'));
      setStopText(current.stop.join('\n'));
      setChangeText(current.change.join('\n'));
      setSummary(current.summary ?? '');
      setFindingTitle(current.findings[0]?.title ?? '');
      setFindingBody(current.findings[0]?.body ?? '');
      const links = await window.wmb.listReviewBacklinks({
        reviewIds: [current.id],
        findingIds: current.findings.map((item) => item.id)
      });
      setBacklinks(links);
    } else {
      setKeepText('');
      setStopText('');
      setChangeText('');
      setSummary('');
      setFindingTitle('');
      setFindingBody('');
      setBacklinks([]);
    }
  };
  useEffect(() => { void loadPublicationContext(selected?.publication.id ?? null); }, [selected?.publication.id]);
  const capturePublication = async () => {
    if (!selected || selected.publication.platform !== 'x' || busy) return;
    setBusy(true);
    setStatusText('正在采集发布指标…');
    try {
      const capture = await window.wmb.collectXMetrics(selected.publication.id) as {
        sourceUrl: string;
        capturedAt: string;
        normalized: Record<string, { status: string; value?: number; rawLabel?: string }>;
      };
      await loadPublicationContext(selected.publication.id);
      const views = capture.normalized.views;
      setStatusText(`已采集：views=${views?.status === 'value' ? views.value : views?.status}; source=${capture.sourceUrl}`);
      refresh();
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const captureAccount = async () => {
    if (busy) return;
    setBusy(true);
    setStatusText('正在采集账号粉丝…');
    try {
      const saved = await window.wmb.collectXAccountMetrics();
      if (!saved.ok) throw new Error(saved.error?.message || '账号指标采集失败');
      const listed = await window.wmb.listAccountMetricSnapshots();
      setAccountSnapshots(listed);
      const latest = listed[0];
      const followers = latest?.normalized?.followers as { status?: string; value?: number; rawLabel?: string } | undefined;
      setStatusText(`账号粉丝：${followers?.status === 'value' ? followers.value : followers?.status || '无'} · ${latest?.sourceUrl || ''}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const splitLines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const saveCurrentReview = async (status: 'draft' | 'final') => {
    if (!selected || busy) return;
    if (!snapshots.length) {
      setStatusText('没有指标快照时不能形成数据驱动复盘。');
      return;
    }
    setBusy(true);
    setStatusText(status === 'final' ? '正在定稿复盘…' : '正在保存草稿…');
    try {
      const result = await window.wmb.saveReview({
        id: activeReview && activeReview.status !== 'final' ? activeReview.id : undefined,
        publicationId: selected.publication.id,
        metricSnapshotIds: [snapshots[0].id],
        keep: splitLines(keepText),
        stop: splitLines(stopText),
        change: splitLines(changeText),
        summary: summary.trim() || undefined,
        status,
        expectedRevision: activeReview && activeReview.status !== 'final' ? activeReview.revision : undefined,
        findings: findingTitle.trim() && findingBody.trim()
          ? [{ title: findingTitle.trim(), body: findingBody.trim() }]
          : []
      });
      if (!result.ok) throw new Error(result.error?.message || '复盘保存失败');
      await loadPublicationContext(selected.publication.id);
      setStatusText(status === 'final' ? '复盘已定稿' : '复盘草稿已保存');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const startPiReview = async () => {
    if (!selected || busy) return;
    if (!latestSnapshot && !snapshots.length) {
      setStatusText('没有指标快照时不能让 Pi 做数据驱动复盘。');
      return;
    }
    setBusy(true);
    setStatusText('Pi 正在复盘…');
    try {
      const result = await window.wmb.startResultsReview({
        businessDate: planDate,
        publicationId: selected.publication.id
      });
      if (!result.ok) throw new Error(result.error?.message || 'Pi 复盘失败');
      await loadPublicationContext(selected.publication.id);
      setStatusText('Pi 复盘已完成');
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await loadPublicationContext(selected.publication.id);
    }
  };
  const latestSnapshot = snapshots[0] ?? null;
  const latestAccount = accountSnapshots[0] ?? null;
  const locked = activeReview?.status === 'final';
  const preferredOrder = ['views', 'likes', 'replies', 'reposts', 'bookmarks', 'shares', 'followers'];
  const metricKeys = [...new Set(snapshots.flatMap((snap) => Object.keys(snap.normalized)))]
    .sort((a, b) => (preferredOrder.indexOf(a) === -1 ? 99 : preferredOrder.indexOf(a)) - (preferredOrder.indexOf(b) === -1 ? 99 : preferredOrder.indexOf(b)));
  const cardKeys = metricKeys.filter((key) => snapshots.some((snap) => snap.normalized[key]?.status === 'value')).slice(0, 4);
  const chronological = [...snapshots].reverse();
  const sparkOf = (key: string) => {
    const values = chronological.map((snap) => snap.normalized[key]?.status === 'value' ? Number(snap.normalized[key]?.value ?? 0) : null);
    const max = Math.max(...values.map((value) => value ?? 0), 1);
    return values.map((value) => value === null ? 4 : Math.max(8, Math.round(value / max * 100)));
  };
  const deltaOf = (key: string) => {
    const withValue = snapshots.filter((snap) => snap.normalized[key]?.status === 'value');
    if (withValue.length < 2) return null;
    return Number(withValue[0].normalized[key]?.value ?? 0) - Number(withValue[1].normalized[key]?.value ?? 0);
  };
  return <section className="workflow-page">
    <header className="page-heading">
      <div><span>内容结果</span><h1>什么有效，下一次怎么做</h1><p>只根据真实发布和已采集的网页数据形成复盘。</p></div>
      <div className="heading-actions">
        <button className="secondary-button" disabled={busy || !selected || selected.publication.platform !== 'x'} onClick={() => void capturePublication()}>{busy ? '处理中…' : '采集发布指标'}</button>
        <button className="secondary-button" disabled={busy} onClick={() => void captureAccount()}>采集账号粉丝</button>
        <button className="primary-button" disabled={busy || !selected || !snapshots.length || locked} onClick={() => void startPiReview()}>{busy ? 'Pi 处理中…' : '让 Pi 复盘'}</button>
      </div>
    </header>
    {statusText && <p className="task-status" data-running={busy ? 'true' : 'false'}>{statusText}</p>}
    <div className="results-layout">
      <aside className="workflow-list">
        <div className="section-heading"><h2>已发布内容</h2><span>{published.length}</span></div>
        {published.length ? <div className="publication-list">{published.map((item) => {
          const pub = item.publication;
          const title = item.payload?.title || item.payload?.body.slice(0, 42) || pub.externalUrl || pub.id;
          return <button className={pub.id === selected?.publication.id ? 'active' : ''} key={pub.id} onClick={() => setSelectedId(pub.id)}>
            <strong>{title}</strong>
            <span>{platformNames[pub.platform]} · {pub.publishedAt ? new Date(pub.publishedAt).toLocaleString() : '未知时间'}</span>
          </button>;
        })}</div> : <div className="compact-empty"><h3>还没有可复盘内容</h3><p>取得真实发布地址后，内容会按发布时间显示在这里。</p></div>}
      </aside>
      <main className="results-main">
        {selected ? <section className="metrics-panel">
          <span className="section-label">指标快照</span>
          <h2>{selected.payload?.title || selected.payload?.body.slice(0, 48) || '已发布内容'}</h2>
          <dl className="metric-meta">
            <div><dt>来源页面</dt><dd>{selected.publication.externalUrl ? <button className="text-button" onClick={() => void window.wmb.openExternal(selected.publication.externalUrl!)}>{selected.publication.externalUrl}</button> : '无'}</dd></div>
            <div><dt>计划采集</dt><dd>{latestSnapshot?.scheduledFor ? new Date(latestSnapshot.scheduledFor).toLocaleString() : '尚未生成任务窗口'}</dd></div>
            <div><dt>实际采集</dt><dd>{latestSnapshot?.capturedAt ? new Date(latestSnapshot.capturedAt).toLocaleString() : '尚未采集'}</dd></div>
            <div><dt>复盘状态</dt><dd>{activeReview ? (activeReview.status === 'final' ? '已定稿' : '草稿') : (latestSnapshot ? '可写复盘' : '等待指标')}</dd></div>
          </dl>
          {cardKeys.length > 0 && <div className="metric-cards">{cardKeys.map((key) => {
            const latest = snapshots.find((snap) => snap.normalized[key]?.status === 'value')?.normalized[key];
            const delta = deltaOf(key);
            return <div className="metric-card" key={key}>
              <div className="stat-label">{key}</div>
              <div className="metric-value">{latest?.status === 'value' ? Number(latest.value).toLocaleString('zh-CN') : '—'}</div>
              <div className={`metric-delta${delta === null ? '' : delta >= 0 ? ' up' : ' down'}`}>{delta === null ? '单次采集' : `${delta >= 0 ? '▲ +' : '▼ '}${delta.toLocaleString('zh-CN')}`}</div>
              <div className="spark">{sparkOf(key).map((height, index) => <i key={index} className={index === sparkOf(key).length - 1 ? 'hot' : ''} style={{ height: `${height}%` }}/>)}</div>
            </div>;
          })}</div>}
          {snapshots.length > 0 && cardKeys.length > 0 && <section className="snap-windows"><h3>采集窗口 · {snapshots.length}</h3>
            <table className="snap-table"><thead><tr><th>计划时间</th><th>实际采集</th>{cardKeys.map((key) => <th key={key}>{key}</th>)}<th>字段状态</th></tr></thead><tbody>
              {snapshots.map((snap) => {
                const missing = cardKeys.filter((key) => snap.normalized[key]?.status !== 'value').length;
                return <tr key={snap.id}>
                  <td className="num faint">{new Date(snap.scheduledFor).toLocaleString('zh-CN')}</td>
                  <td className="num">{new Date(snap.capturedAt).toLocaleString('zh-CN')}</td>
                  {cardKeys.map((key) => <td className="num" key={key}>{snap.normalized[key]?.status === 'value' ? Number(snap.normalized[key]?.value).toLocaleString('zh-CN') : '—'}</td>)}
                  <td>{missing === 0 ? <span className="pill-status green"><span className="dot"/>全部有值</span> : <span className="pill-status gray">{missing} 项不可见</span>}</td>
                </tr>;
              })}
            </tbody></table></section>}
          {latestSnapshot ? <div className="metric-tables">
            <section>
              <h3>归一化指标</h3>
              <table><thead><tr><th>字段</th><th>状态</th><th>数值</th><th>原始标签</th></tr></thead><tbody>
                {Object.entries(latestSnapshot.normalized).map(([key, field]) => <tr key={key}><td>{key}</td><td>{field.status}</td><td>{field.status === 'value' ? String(field.value) : '—'}</td><td>{field.rawLabel || '—'}</td></tr>)}
              </tbody></table>
            </section>
            <section>
              <h3>原始字段</h3>
              <table><thead><tr><th>字段</th><th>状态</th><th>数值</th><th>原始标签</th></tr></thead><tbody>
                {Object.entries(latestSnapshot.raw).map(([key, field]) => <tr key={key}><td>{key}</td><td>{field.status}</td><td>{field.status === 'value' ? String(field.value) : '—'}</td><td>{field.rawLabel || '—'}</td></tr>)}
              </tbody></table>
            </section>
          </div> : <section className="metrics-empty"><h2>还没有该内容的指标快照</h2><p>没有快照时复盘只能保持草稿，不会被当作完成的数据驱动复盘。</p></section>}
          {latestAccount && <section className="account-metrics">
            <h3>账号快照</h3>
            <p>{latestAccount.platform} · {new Date(latestAccount.capturedAt).toLocaleString()} · {latestAccount.sourceUrl}</p>
            <table><thead><tr><th>字段</th><th>状态</th><th>数值</th><th>原始标签</th></tr></thead><tbody>
              {Object.entries(latestAccount.normalized).map(([key, field]) => {
                const value = field as { status?: string; value?: number; rawLabel?: string };
                return <tr key={key}><td>{key}</td><td>{value.status || '—'}</td><td>{value.status === 'value' ? String(value.value) : '—'}</td><td>{value.rawLabel || '—'}</td></tr>;
              })}
            </tbody></table>
          </section>}
        </section> : <section className="metrics-empty"><span className="section-label">指标快照</span><h2>等待第一条真实发布</h2><p>数据会保留采集时间、来源页面和字段状态。暂不可见的指标不会被写成 0。</p></section>}
        <section className="review-editor">
          <div className="section-heading"><h2>复盘</h2><span>{activeReview ? activeReview.status : '未创建'}</span></div>
          <label className="review-field"><span>摘要</span><textarea disabled={locked || busy} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="一句话说明这次内容的结果判断" /></label>
          <div className="review-grid editable">
            <label><span>Keep（保留）</span><textarea disabled={locked || busy} value={keepText} onChange={(event) => setKeepText(event.target.value)} placeholder="每行一条" /></label>
            <label><span>Stop（停止）</span><textarea disabled={locked || busy} value={stopText} onChange={(event) => setStopText(event.target.value)} placeholder="每行一条" /></label>
            <label><span>Change（改变）</span><textarea disabled={locked || busy} value={changeText} onChange={(event) => setChangeText(event.target.value)} placeholder="每行一条" /></label>
          </div>
          {!locked && <div className="heading-actions">
            <button className="secondary-button" disabled={busy || !selected || !latestSnapshot} onClick={() => void saveCurrentReview('draft')}>保存草稿</button>
            <button className="primary-button" disabled={busy || !selected || !latestSnapshot} onClick={() => void saveCurrentReview('final')}>定稿复盘</button>
          </div>}
        </section>
      </main>
      <aside className="findings-panel">
        <span className="section-label">方法结论</span>
        {activeReview?.findings?.length ? <>
          <h2>{activeReview.findings[0].title}</h2>
          <p>{activeReview.findings[0].body}</p>
        </> : <>
          <h2>{locked ? '无方法结论' : '写一条方法结论'}</h2>
          {!locked && <>
            <label className="review-field"><span>标题</span><input disabled={busy} value={findingTitle} onChange={(event) => setFindingTitle(event.target.value)} placeholder="例如：视频封面要先给结论" /></label>
            <label className="review-field"><span>内容</span><textarea disabled={busy} value={findingBody} onChange={(event) => setFindingBody(event.target.value)} placeholder="后续方案可引用这条结论" /></label>
          </>}
        </>}
        <section className="backlink-list">
          <h3>后续方案回流</h3>
          {backlinks.length ? backlinks.map((link) => (
            <article key={link.planItemId}>
              <strong>{link.planItemTitle}</strong>
              <span>{link.planDate} · 计划 {link.planId.slice(0, 8)}</span>
            </article>
          )) : <p>还没有后续方案引用这份复盘或方法结论。</p>}
        </section>
      </aside>
    </div>
  </section>;
}

function publicationStatus(status: string): string {
  return ({ prepared: '已准备', awaiting_confirmation: '等待人工发布', published: '已发布', failed: '失败', needs_user: '需要接管', unknown: '待对账' } as Record<string, string>)[status] || status;
}

function platformIcon(platform?: string): string {
  return ({ x: '𝕏', xiaohongshu: '红', wechat: '微' } as Record<string, string>)[platform ?? ''] ?? '·';
}

function timelineDot(status: string): string {
  if (status === 'published' || status === 'prepared') return 'ok';
  if (status === 'awaiting_confirmation' || status === 'needs_user') return 'wait';
  if (status === 'failed' || status === 'unknown') return 'err';
  return 'idle';
}
