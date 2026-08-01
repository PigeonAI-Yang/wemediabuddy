import fs from 'fs';

const path = 'src/renderer/main.tsx';
let t = fs.readFileSync(path, 'utf8');

if (!t.includes("from './library-topics-view'")) {
  t = t.replace(
    "import { Icon, TodayView, LibraryView } from './today-library-view';",
    "import { Icon, TodayView, LibraryView } from './today-library-view';\nimport { LibraryTopicsView } from './library-topics-view';",
  );
}

t = t.replace(
  `function normalizeView(raw: string | null): View {
  if (!raw) return 'today';
  if (raw === 'compose') return 'canvas';
  // Collapse retired knowledge-system routes into Library.
  if (raw === 'knowledge' || raw === 'topic') return 'library';
  return views.includes(raw as View) ? raw as View : 'today';
}`,
  `function normalizeView(raw: string | null): View {
  if (!raw) return 'today';
  if (raw === 'compose') return 'canvas';
  // Retired knowledge-system home collapses into primary Topics.
  if (raw === 'knowledge') return 'topic';
  return views.includes(raw as View) ? raw as View : 'today';
}`,
);

t = t.replace(
  `  useEffect(() => {
    if (view !== 'library') setLibraryTopicContext(null);
  }, [view]);
  const openGlobalResult = (item: (typeof globalResults)[number]) => {
    if (item.kind === 'topic') {
      localStorage.setItem('wmb.librarySection', 'topics');
      localStorage.setItem('wmb.libraryTopicId', item.id);
      navigate('library');
      window.dispatchEvent(new CustomEvent('wmb-open-library-topic', { detail: { topicId: item.id } }));
    } else if (item.kind === 'project') {
      setStudioSelectedId(item.id);
      navigate('studio');
    } else {
      // Domains are no longer a primary nav surface; fall back to topics list.
      localStorage.setItem('wmb.librarySection', 'topics');
      navigate('library');
    }
    setGlobalQuery('');
    setGlobalResults([]);
  };`,
  `  useEffect(() => {
    if (view !== 'topic') setLibraryTopicContext(null);
  }, [view]);
  const openTopic = (topicId: string) => {
    localStorage.setItem('wmb.libraryTopicId', topicId);
    navigate('topic');
    window.dispatchEvent(new CustomEvent('wmb-open-library-topic', { detail: { topicId } }));
  };
  const openGlobalResult = (item: (typeof globalResults)[number]) => {
    if (item.kind === 'topic') {
      openTopic(item.id);
    } else if (item.kind === 'project') {
      setStudioSelectedId(item.id);
      navigate('studio');
    } else {
      navigate('topic');
    }
    setGlobalQuery('');
    setGlobalResults([]);
  };`,
);

t = t.replace(
  "const pageLabels: Record<View, string> = { today: '今日内容', discover: '发现', knowledge: '资料库', topic: '主题', library: '资料库', canvas: '关系画布', studio: '创作', publish: '发布', results: '结果', settings: '设置' };",
  "const pageLabels: Record<View, string> = { today: '今日内容', discover: '发现', knowledge: '主题', topic: '主题', library: '资料库', canvas: '关系画布', studio: '创作', publish: '发布', results: '结果', settings: '设置' };",
);

t = t.replace(
  `    if (view === 'library') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: libraryTopicContext ? 'topic' : null,
        objectId: libraryTopicContext?.id ?? null,
        objectTitle: libraryTopicContext?.title ?? null
      };
    }`,
  `    if (view === 'topic') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: libraryTopicContext ? 'topic' : null,
        objectId: libraryTopicContext?.id ?? null,
        objectTitle: libraryTopicContext?.title ?? null
      };
    }
    if (view === 'library') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: null,
        objectId: null,
        objectTitle: null
      };
    }`,
);

const sidebar = `    <aside className="sidebar"><div><nav aria-label="工作流"><div className="nav-group-label">工作流</div><button className={view === 'today' ? 'active' : ''} onClick={() => navigate('today')} title="今日"><Icon name="today"/><span>今日</span></button>{nav.slice(1).map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)} title={item.label}><Icon name={item.id}/><span>{item.label}</span></button>)}</nav><nav aria-label="知识资产"><div className="nav-group-label">知识资产</div><button className={view === 'topic' ? 'active' : ''} onClick={() => navigate('topic')} title="主题"><Icon name="knowledge"/><span>主题</span></button><button className={view === 'library' ? 'active' : ''} onClick={() => navigate('library')} title="资料库"><Icon name="library"/><span>资料库</span></button><button className={view === 'canvas' ? 'active' : ''} onClick={() => navigate('canvas')} title="关系画布"><Icon name="canvas"/><span>关系画布</span></button></nav></div><nav className="sidebar-bottom"><button className={view === 'settings' ? 'active' : ''} onClick={() => navigate('settings')} title="设置"><Icon name="settings"/><span>设置</span></button></nav></aside>`;

if (!t.includes('<aside className="sidebar">')) {
  throw new Error('sidebar not found');
}
t = t.replace(/    <aside className="sidebar">[\s\S]*?<\/aside>/, sidebar);

const oldMount = `{view === 'library' && <LibraryView onTopicContextChange={setLibraryTopicContext} onOpenStudio={(id) => { setStudioSelectedId(id); navigate('studio'); }} onOpenCanvas={(canvasId) => { if (canvasId) setCanvasOpenId(canvasId); navigate('canvas'); }}/>}`;
const newMount = `{view === 'topic' && <section className="page library-page topic-page"><header className="library-home-head"><div><p className="eyebrow">长期记忆</p><h1>主题</h1><p>跨天判断与证据在这里直接打开，不必先钻进资料库。</p></div></header><LibraryTopicsView initialTopicId={localStorage.getItem('wmb.libraryTopicId')} onTopicContextChange={setLibraryTopicContext} onOpenStudio={(id) => { setStudioSelectedId(id); navigate('studio'); }} onOpenCanvas={(canvasId) => { if (canvasId) setCanvasOpenId(canvasId); navigate('canvas'); }} /></section>}
      {view === 'library' && <LibraryView onOpenTopic={(topicId) => openTopic(topicId)} onOpenStudio={(id) => { setStudioSelectedId(id); navigate('studio'); }} onOpenCanvas={(canvasId) => { if (canvasId) setCanvasOpenId(canvasId); navigate('canvas'); }}/>}`;

if (!t.includes(oldMount)) {
  throw new Error('library mount not found');
}
t = t.replace(oldMount, newMount);

fs.writeFileSync(path, t);
console.log('main rewritten');
