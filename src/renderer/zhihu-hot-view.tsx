import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ZHIHU_CATEGORIES = [
  { id: 'index', label: '索引', description: '话题目录' },
  { id: 'intro', label: '简介', description: '官方简介' },
  { id: 'discussion', label: '讨论', description: '最新讨论' },
  { id: 'essence', label: '精华', description: '高质量回答' },
  { id: 'unanswered', label: '等待回答', description: '待回答问题' }
] as const;
type ZhihuCategory = typeof ZHIHU_CATEGORIES[number]['id'];
type ZhihuCategoryData = Awaited<ReturnType<typeof window.wmb.readZhihuHotCategory>>;
type RefreshState = 'idle' | 'loading' | 'success' | 'failure';

function displayTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ZhihuHotView(): React.JSX.Element {
  const [category, setCategory] = useState<ZhihuCategory>('discussion');
  const [data, setData] = useState<ZhihuCategoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');
  const successTimerRef = useRef<number | null>(null);
  const selected = useMemo(() => ZHIHU_CATEGORIES.find((item) => item.id === category) ?? ZHIHU_CATEGORIES[2], [category]);

  const load = useCallback(async () => {
    setLoading(true);
    setData(null);
    setError('');
    try {
      setData(await window.wmb.readZhihuHotCategory(category, 50));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [category]);

  const refresh = useCallback(async () => {
    if (refreshState === 'loading') return;
    if (successTimerRef.current !== null) {
      window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
    setRefreshState('loading');
    setError('');
    try {
      const result = await window.wmb.refreshZhihuHotCategory(category, 50);
      setData(result.snapshot as ZhihuCategoryData);
      if (result.status === 'succeeded') {
        setRefreshState('success');
        successTimerRef.current = window.setTimeout(() => setRefreshState('idle'), 1200) as unknown as number;
      } else {
        setRefreshState('failure');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setRefreshState('failure');
    }
  }, [category, refreshState]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setRefreshState('idle');
    if (successTimerRef.current !== null) {
      window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, [category]);
  useEffect(() => () => {
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
  }, []);

  const refreshButtonMeta = useMemo(() => {
    if (refreshState === 'loading') return { icon: '↻', label: `正在刷新知乎${selected.label}`, title: `正在刷新知乎${selected.label}` };
    if (refreshState === 'success') return { icon: '✓', label: '刷新成功', title: '刷新成功' };
    if (refreshState === 'failure') return { icon: '!', label: '刷新失败，请重试', title: '刷新失败，请重试' };
    return { icon: '↻', label: `刷新知乎${selected.label}`, title: `刷新知乎${selected.label}` };
  }, [refreshState, selected.label]);

  const sourceUrl = data?.evidenceUrl;
  const emptyTitle = `${selected.label}暂无内容`;
  const emptyCopy = selected.id === 'index' || selected.id === 'intro'
    ? '点击刷新后读取知乎官方摘要；摘要仅在当前会话展示。'
    : '在当前分类完成真实刷新后，已采集的问题会显示在这里。';

  return <section className="zhihu-hot-view" aria-label="知乎 AI 话题">
    <div className="page-toolbar ranking-toolbar zhihu-hot-toolbar">
      <div className="zhihu-hot-summary">
        <strong>知乎 AI 话题</strong>
        <span>{selected.description}</span>
      </div>
      <button
        className={`refresh-button zhihu-refresh-button is-${refreshState}`}
        disabled={refreshState === 'loading'}
        aria-busy={refreshState === 'loading'}
        aria-label={refreshButtonMeta.label}
        title={refreshButtonMeta.title}
        onClick={() => void refresh()}
      >
        <span className="zhihu-refresh-icon" aria-hidden="true">{refreshButtonMeta.icon}</span>
      </button>
    </div>
    <nav className="zhihu-hot-categories" role="tablist" aria-label="知乎 AI 话题分类">
      {ZHIHU_CATEGORIES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={category === item.id} className={category === item.id ? 'active' : ''} onClick={() => { setCategory(item.id); }}>
        <strong>{item.label}</strong><span>{item.description}</span>
      </button>)}
    </nav>
    {error ? <section className="empty-state library-empty">
      <h2>知乎{selected.label}读取失败</h2><p>{error}</p><button onClick={() => void load()}>重新读取</button>
    </section> : loading && !data ? <section className="ranking-loading">正在读取知乎{selected.label}…</section>
      : <>
        {data?.summary ? <section className="zhihu-hot-summary-card"><h2>{selected.label}</h2><p>{data.summary}</p><small>本轮刷新读取的知乎官方摘要，仅在当前会话显示。</small></section> : null}
        {!data?.items.length && !data?.summary ? <section className="empty-state library-empty">
          <h2>{emptyTitle}</h2><p>{emptyCopy}</p>
          {sourceUrl ? <button onClick={() => void window.wmb.openExternal(sourceUrl)}>打开知乎{selected.label}</button> : null}
        </section>
          : data?.items.length ? <div className="ranking-list zhihu-hot-list">{data.items.map((item) => {
            const itemUrl = item.url || item.canonicalUrl || item.questionUrl;
            return <article key={item.sourceItemId ?? item.canonicalUrl ?? item.url}>
              <strong className="ranking-number">{item.rank}</strong>
              <div className="zhihu-hot-copy">
                <h2>{item.title}</h2>
                {item.excerpt ? <p>{item.excerpt}</p> : null}
                <small>{[item.heatText, item.collectedAt ? `采集于 ${displayTime(item.collectedAt)}` : null, `知乎${selected.label}`].filter(Boolean).join(' · ')}</small>
              </div>
              <button className="ranking-save" disabled title="已收入资料库" aria-label={`${item.title} 已收入资料库`}>✓</button>
              <button className="ranking-open" title="查看知乎原文" aria-label={`查看 ${item.title}`} onClick={() => void window.wmb.openExternal(itemUrl)}><span aria-hidden="true">↗</span></button>
            </article>;
          })}</div> : null}
      </>}
    {data?.collectedAt && sourceUrl ? <p className="ranking-footnote">更新于 {displayTime(data.collectedAt)} · 数据来自 <button onClick={() => void window.wmb.openExternal(sourceUrl)}>知乎{selected.label}</button></p> : null}
  </section>;
}
