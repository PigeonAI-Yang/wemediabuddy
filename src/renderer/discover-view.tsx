import { useEffect, useMemo, useState } from 'react';
import type { RankingContext, RankingContextItem, XListPiContext } from './app-types';
import { XListsView } from './x-lists-view';

// 发现页:AI 榜单是临时发现流,不是已入库资产;点「入库」才通过 upsertSource 真正写入资料库。
export function DiscoverView({ rankingContext, onRankingContextChange, onStatusChange, onXListContextChange }: {
  rankingContext: RankingContext;
  onRankingContextChange: (context: RankingContext) => void;
  onStatusChange?: (status: { text: string; running?: boolean } | null) => void;
  onXListContextChange?: (context: XListPiContext | null) => void;
}): React.JSX.Element {
  const [rankings, setRankings] = useState<Awaited<ReturnType<typeof window.wmb.getGitHubRankings>> | null>(null);
  const [sourceId, setSourceId] = useState(() => localStorage.getItem('wmb.discoverSource') ?? 'github');
  const [boardId, setBoardId] = useState(() => localStorage.getItem('wmb.discoverBoard') ?? 'github-daily');
  const [section, setSection] = useState<'rankings' | 'lists'>(() => localStorage.getItem('wmb.discoverSection') === 'lists' ? 'lists' : 'rankings');
  const [rankingError, setRankingError] = useState('');
  const [loadingRankings, setLoadingRankings] = useState(false);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [saveNote, setSaveNote] = useState('');
  const loadRankings = async (refresh = true) => {
    setLoadingRankings(true);
    setRankingError('');
    try { setRankings(await window.wmb.getGitHubRankings(refresh)); }
    catch (error) {
      setRankings((current) => {
        if (!current) setRankingError(error instanceof Error ? error.message : String(error));
        return current;
      });
    }
    finally { setLoadingRankings(false); }
  };
  useEffect(() => {
    void (async () => {
      let cached: Awaited<ReturnType<typeof window.wmb.getCachedRankings>> = null;
      try { cached = await window.wmb.getCachedRankings(); } catch { /* ignore stale cache read failures */ }
      if (cached) setRankings(cached);
      setLoadingRankings(true);
      setRankingError('');
      try { setRankings(await window.wmb.getGitHubRankings(true)); }
      catch (error) {
        if (!cached) setRankingError(error instanceof Error ? error.message : String(error));
      }
      finally { setLoadingRankings(false); }
    })();
  }, []);
  useEffect(() => { localStorage.setItem('wmb.discoverSection', section); }, [section]);
  useEffect(() => {
    if (section !== 'lists') {
      onStatusChange?.(null);
      onXListContextChange?.(null);
    }
  }, [section, onStatusChange, onXListContextChange]);
  const categories = useMemo(() => {
    const grouped: Array<{ id: string; label: string; sources: Array<{ id: string; label: string; boards: NonNullable<typeof rankings>['boards'] }> }> = [];
    for (const board of rankings?.boards ?? []) {
      let category = grouped.find((item) => item.id === board.kind);
      if (!category) { category = { id: board.kind, label: board.kind === 'rankings' ? '榜单' : board.kind, sources: [] }; grouped.push(category); }
      let source = category.sources.find((item) => item.id === board.sourceId);
      if (!source) { source = { id: board.sourceId, label: board.sourceLabel, boards: [] }; category.sources.push(source); }
      source.boards.push(board);
    }
    return grouped;
  }, [rankings]);
  const category = categories[0] ?? null;
  const sources = category?.sources ?? [];
  const source = sources.find((item) => item.id === sourceId) ?? sources[0] ?? null;
  const board = source?.boards.find((item) => item.id === boardId) ?? source?.boards[0];
  const selectBoard = (selectedBoard: NonNullable<typeof board>) => {
    const selectedItems = selectedBoard.items.map((item) => ({ ...item, boardId: selectedBoard.id, boardLabel: selectedBoard.label }));
    setBoardId(selectedBoard.id);
    onRankingContextChange({
      boards: [{ id: selectedBoard.id, label: selectedBoard.label, sourceUrl: selectedBoard.sourceUrl, items: selectedItems }],
      items: []
    });
  };
  const toggleRankingItem = (item: RankingContextItem) => {
    const selected = rankingContext.items.some((value) => value.boardId === item.boardId && value.name === item.name);
    onRankingContextChange({
      boards: [],
      items: selected
        ? rankingContext.items.filter((value) => value.boardId !== item.boardId || value.name !== item.name)
        : [...rankingContext.items, item]
    });
  };
  const saveToLibrary = async (item: RankingContextItem) => {
    const key = `${item.boardId}:${item.name}`;
    const result = await window.wmb.saveDiscoveredSource({
      title: item.name,
      originalUrl: item.url,
      summary: item.description || undefined,
      author: item.boardLabel,
      categories: ['AI 榜单', item.boardLabel]
    });
    if (result.ok) {
      setSavedKeys((current) => new Set([...current, key]));
      setSaveNote(`已收入资料库:${item.name}`);
    } else {
      setSaveNote(result.error?.message || '入库失败');
    }
  };
  return <section className="page library-page discover-page">
    <nav className="discover-categories" aria-label="发现分页面"><button className={`library-section-tab${section === 'rankings' ? ' active' : ''}`} onClick={() => setSection('rankings')}>榜单</button><button className={`library-section-tab${section === 'lists' ? ' active' : ''}`} onClick={() => setSection('lists')}>X Lists</button></nav>
    {section === 'lists' ? <XListsView onStatusChange={onStatusChange} onContextChange={onXListContextChange}/> : <div onClick={(event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('[data-ranking-item], button, a, input, select, textarea')) onRankingContextChange({ boards: [], items: [] });
  }}>
    <div className="discover-sources">{sources.map((item) => <button className={`chip${item.id === source?.id ? ' on' : ''}`} key={item.id} onClick={() => { setSourceId(item.id); const first = item.boards[0]; if (first) selectBoard(first); }}>{item.label}<span className="chip-count">{item.boards.length}</span></button>)}</div>
    <div className="page-toolbar ranking-toolbar">
      <div className="filter-row">{source?.boards.map((item) => <button className={`filter${item.id === board?.id ? ' active' : ''}${rankingContext.boards.some((selected) => selected.id === item.id) ? ' context-selected' : ''}`} key={item.id} onClick={() => selectBoard(item)}>{rankingContext.boards.some((selected) => selected.id === item.id) ? '✓ ' : ''}{item.label}</button>)}</div>
      <div className="ranking-actions"><button className="refresh-button" disabled={loadingRankings} title={loadingRankings ? '正在刷新榜单' : '刷新榜单'} aria-label={loadingRankings ? '正在刷新榜单' : '刷新榜单'} onClick={() => void loadRankings(true)}><span className={loadingRankings ? 'ranking-refresh-spinning' : ''} aria-hidden="true">↻</span></button></div>
    </div>
    {saveNote && <p className="task-status" data-running="false">{saveNote}</p>}
    {rankingError ? <section className="empty-state library-empty"><h2>榜单读取失败</h2><p>{rankingError}</p></section>
      : !rankings || loadingRankings && !board ? <section className="ranking-loading">正在读取最新榜单…</section>
      : board?.status === 'unavailable' ? <section className="empty-state library-empty"><h2>{board.label} 暂时不可读</h2><p>{board.error}</p><button onClick={() => void window.wmb.openExternal(board.sourceUrl)}>打开来源</button></section>
      : <div className="ranking-list">{board?.items.map((item) => {
        const contextItem = { ...item, boardId: board.id, boardLabel: board.label };
        const selected = rankingContext.items.some((value) => value.boardId === board.id && value.name === item.name);
        const saved = savedKeys.has(`${board.id}:${item.name}`);
        return <article key={`${board.id}-${item.name}`} data-ranking-item className={selected ? 'selected' : ''} onClick={() => toggleRankingItem(contextItem)}>
        <strong className="ranking-number">{item.rank}</strong>
        <div><h2>{item.name}</h2><p>{item.description || '该项目尚未提供简介。'}</p><small>{[item.language, item.stars && `★ ${item.stars}`, item.gained].filter(Boolean).join(' · ')}</small></div>
        {selected && <span className="ranking-check" aria-label="已选中">✓</span>}
        <button className="ranking-save" disabled={saved} title={saved ? '已在资料库' : '收入资料库'} aria-label={`收入资料库 ${item.name}`} onClick={(event) => { event.stopPropagation(); void saveToLibrary(contextItem); }}>{saved ? '✓' : '＋'}</button>
        <button className="ranking-open" title="查看项目" aria-label={`查看 ${item.name}`} onClick={(event) => { event.stopPropagation(); void window.wmb.openExternal(item.url); }}><span aria-hidden="true">↗</span></button>
      </article>; })}</div>}
    {rankings && <p className="ranking-footnote">更新于 {new Date(rankings.fetchedAt).toLocaleString('zh-CN')} · 数据来自 <button onClick={() => board && void window.wmb.openExternal(board.sourceUrl)}>{board?.label}</button></p>}</div>}
  </section>;
}
