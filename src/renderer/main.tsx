import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import type { TodayPlanItem } from '../main/workbench';
import { LongTermStudioView } from './studio-view';
import { KnowledgeCanvasView } from './knowledge-canvas-view';
import { DomainMapView, TopicDossierView } from './knowledge-system-view';
import { CreativeComposerView } from './creative-composer-view';
import { Icon, TodayView, LibraryView } from './today-library-view';
import { LegacyStudioView } from './legacy-studio-view';
import { PublishView, ResultsView } from './publishing-results-view';
import { SettingsView } from './settings-view';
import { PiDock } from './pi-dock';
import type { PiContextRef, RankingContext, Theme, View } from './app-types';
import { logoUrl, views } from './app-types';
import './styles.css';

function App(): React.JSX.Element {
  let restoredCreativeContext:null|{canvasId:string;nodeIds:string[];mode:'current_page'|'selected';title:string}=null;
  try{restoredCreativeContext=JSON.parse(localStorage.getItem('wmb.creativeContext')??'null');}catch{}
  const restoredTopicId=localStorage.getItem('wmb.knowledgeTopicId');
  const storedView=localStorage.getItem('wmb.view');
  const restoredView:View=views.includes(storedView as View)?storedView as View:'today';
  const [view, setView] = useState<View>(restoredView==='compose'&&!restoredCreativeContext?'knowledge':restoredView==='topic'&&!restoredTopicId?'knowledge':restoredView);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('wmb.theme') === 'light' ? 'light' : 'dark');
  const [dataRoot, setDataRoot] = useState<string | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof window.wmb.getSettings>>>(null);
  const [today, setToday] = useState<Awaited<ReturnType<typeof window.wmb.getToday>>>(null);
  const [publications, setPublications] = useState<Awaited<ReturnType<typeof window.wmb.getPublications>>>([]);
  const [browserChoice, setBrowserChoice] = useState('');
  const [piDockCollapsed, setPiDockCollapsed] = useState(() => localStorage.getItem('wmb.piDockCollapsed') === 'true');
  const [piDockWidth, setPiDockWidth] = useState(() => Number(localStorage.getItem('wmb.piDockWidth')) || 380);
  const [todaySelectedItems, setTodaySelectedItems] = useState<TodayPlanItem[]>([]);
  const [rankingContext, setRankingContext] = useState<RankingContext>({ boards: [], items: [] });
  const [creativeContext,setCreativeContext] = useState<{canvasId:string;nodeIds:string[];mode:'current_page'|'selected';title:string}|null>(restoredCreativeContext);
  const [canvasContext,setCanvasContext]=useState<{canvasId:string;nodeIds:string[];mode:'current_page'|'selected';title:string}|null>(null);
  const [knowledgeTopicId,setKnowledgeTopicId]=useState<string|null>(restoredTopicId);
  const [knowledgeDomainId,setKnowledgeDomainId]=useState<string|null>(()=>localStorage.getItem('wmb.knowledgeDomainId'));
  const [globalQuery,setGlobalQuery]=useState('');
  const [globalResults,setGlobalResults]=useState<Array<{kind:'domain'|'topic'|'project';id:string;title:string}>>([]);
  const [studioSelectedId, setStudioSelectedId] = useState<string | null>(() => localStorage.getItem('wmb.studioSelectedId'));
  const [studioContext, setStudioContext] = useState<{ id: string; title: string } | null>(null);
  const [publishSelectedId, setPublishSelectedId] = useState<string | null>(null);
  const planDate = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), []);
  const [now, setNow] = useState(() => new Date());
  const [piPhase, setPiPhase] = useState<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle');
  const [piStatusText, setPiStatusText] = useState('Pi 空闲');
  const dateLabel = useMemo(() => new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
    hour12: false
  }).format(now), [now]);
  const refreshSettings = () => void window.wmb.getSettings().then((value) => { setSettings(value); setBrowserChoice(value?.selectedBrowser?.id ?? value?.browserOptions[0]?.id ?? ''); });
  const refreshToday = () => void window.wmb.getToday(planDate).then(setToday);
  const refreshPublications = () => void window.wmb.getPublications().then(setPublications);
  useEffect(() => { void window.wmb.getDataRoot().then((root) => setDataRoot(root?.path ?? null)); refreshSettings(); refreshToday(); refreshPublications(); const poll = window.setInterval(() => { refreshToday(); refreshPublications(); }, 5000); return () => window.clearInterval(poll); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('wmb.theme', theme); }, [theme]);
  useEffect(()=>localStorage.setItem('wmb.view',view),[view]);
  useEffect(()=>{if(knowledgeTopicId)localStorage.setItem('wmb.knowledgeTopicId',knowledgeTopicId);else localStorage.removeItem('wmb.knowledgeTopicId');},[knowledgeTopicId]);
  useEffect(()=>{if(knowledgeDomainId)localStorage.setItem('wmb.knowledgeDomainId',knowledgeDomainId);else localStorage.removeItem('wmb.knowledgeDomainId');},[knowledgeDomainId]);
  useEffect(()=>{if(creativeContext)localStorage.setItem('wmb.creativeContext',JSON.stringify(creativeContext));else localStorage.removeItem('wmb.creativeContext');},[creativeContext]);
  useEffect(()=>{
    const query=globalQuery.trim();if(query.length<2){setGlobalResults([]);return;}
    let active=true;
    void Promise.all([window.wmb.listKnowledgeDomains({query,limit:6}),window.wmb.listKnowledgeTopics({query,limit:6}),window.wmb.listStudioProjects({query,limit:6})]).then(([domains,topics,projects])=>{
      if(!active)return;setGlobalResults([
        ...domains.items.map((item:any)=>({kind:'domain' as const,id:item.id,title:item.title})),
        ...topics.map((item:any)=>({kind:'topic' as const,id:item.id,title:item.title})),
        ...(projects?.items??[]).map(item=>({kind:'project' as const,id:item.id,title:item.title}))
      ]);
    });
    return()=>{active=false;};
  },[globalQuery]);
  useEffect(() => { localStorage.setItem('wmb.piDockCollapsed', String(piDockCollapsed)); }, [piDockCollapsed]);
  useEffect(() => {
    if (studioSelectedId) localStorage.setItem('wmb.studioSelectedId', studioSelectedId);
    else localStorage.removeItem('wmb.studioSelectedId');
  }, [studioSelectedId]);
  const resizePiDock = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (pointer: PointerEvent) => setPiDockWidth(Math.max(300, Math.min(640, window.innerWidth - pointer.clientX)));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing-pi');
    };
    document.body.classList.add('resizing-pi');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };
  const resetPiDockWidth = () => setPiDockWidth(380);
  useEffect(() => { localStorage.setItem('wmb.piDockWidth', String(piDockWidth)); }, [piDockWidth]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!settings?.pi?.configured) {
      setPiPhase('idle');
      setPiStatusText('Pi 未配置');
      return;
    }
    setPiStatusText((current) => (piPhase === 'idle' ? 'Pi 空闲' : current));
    return window.wmb.onPiEvent((event) => {
      if (event.type === 'starting') { setPiPhase('starting'); setPiStatusText('Pi 正在启动'); return; }
      if (event.type === 'running' || event.type === 'delta') { setPiPhase('running'); setPiStatusText('Pi 调用中'); return; }
      if (event.type === 'stopped') { setPiPhase('stopped'); setPiStatusText('Pi 已停止'); return; }
      if (event.type === 'failed') { setPiPhase('failed'); setPiStatusText(event.error ? `Pi 失败：${event.error}` : 'Pi 调用失败'); return; }
      if (event.type === 'idle' || event.type === 'agent_task') {
        setPiPhase('idle');
        setPiStatusText(settings?.pi?.configured ? 'Pi 空闲' : 'Pi 未配置');
      }
    });
  }, [settings?.pi?.configured]);
  const navigate = (next: View) => { setView(next); if (next === 'publish' || next === 'results') refreshPublications(); };
  const openGlobalResult=(item:(typeof globalResults)[number])=>{if(item.kind==='topic'){setKnowledgeTopicId(item.id);navigate('topic');}else if(item.kind==='project'){setStudioSelectedId(item.id);navigate('studio');}else{setKnowledgeDomainId(item.id);navigate('knowledge');}setGlobalQuery('');setGlobalResults([]);};
  const nav = [{ id: 'today', label: '今日' }, { id: 'studio', label: '创作' }, { id: 'publish', label: '发布' }, { id: 'results', label: '结果' }] as const;
  const pageLabels: Record<View, string> = { today: '今日内容',knowledge:'领域地图',topic:'长期主题档案', library: '资料库', canvas: '关系画布',compose:'创作组合台', studio: '创作', publish: '发布', results: '结果', settings: '设置' };
  const publishSelected = publications.find((item) => item.publication.id === publishSelectedId) ?? publications[0] ?? null;
  const piContext: PiContextRef = (() => {
    if (view === 'today') {
      const first = todaySelectedItems[0] ?? null;
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: first ? 'plan_item' : null,
        objectId: first?.id ?? null,
        objectTitle: first?.title ?? null,
        selectedItems: todaySelectedItems
      };
    }
    if (view === 'library') {
      const firstRankingItem = rankingContext.items[0] ?? null;
      const firstRankingBoard = rankingContext.boards[0] ?? null;
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: firstRankingItem ? 'ranking_item' : firstRankingBoard ? 'ranking_board' : null,
        objectId: firstRankingItem ? `${firstRankingItem.boardId}:${firstRankingItem.name}` : firstRankingBoard?.id ?? null,
        objectTitle: firstRankingItem?.name ?? firstRankingBoard?.label ?? null,
        rankingContext
      };
    }
    if(view==='knowledge'||view==='topic')return{page:view,pageLabel:pageLabels[view],objectType:view==='topic'?'topic':null,objectId:knowledgeTopicId,objectTitle:null};
    if (view === 'canvas') return { page:view,pageLabel:pageLabels[view],objectType:'canvas',objectId:canvasContext?.canvasId??null,objectTitle:canvasContext?.title??null,packagePurpose:'discussion',canvasId:canvasContext?.canvasId,contextSelection:canvasContext??undefined };
    if(view==='compose')return{page:view,pageLabel:pageLabels[view],objectType:'canvas',objectId:creativeContext?.canvasId??null,objectTitle:creativeContext?.title??null,packagePurpose:'creation',canvasId:creativeContext?.canvasId,contextSelection:creativeContext??undefined};
    if (view === 'studio') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: studioContext ? 'project' : null,
        objectId: studioContext?.id ?? null,
        objectTitle: studioContext?.title ?? null
      };
    }
    if (view === 'publish') {
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: publishSelected ? 'publication' : null,
        objectId: publishSelected?.publication.id ?? null,
        objectTitle: publishSelected?.payload?.title || publishSelected?.payload?.body.slice(0, 42) || publishSelected?.publication.id || null
      };
    }
    if (view === 'results') {
      const selected = (publications ?? []).find((item) => item.publication.status === 'published') ?? null;
      return {
        page: view,
        pageLabel: pageLabels[view],
        objectType: selected ? 'publication' : null,
        objectId: selected?.publication.id ?? null,
        objectTitle: selected?.payload?.title || selected?.payload?.body.slice(0, 42) || selected?.publication.id || null
      };
    }
    return { page: view, pageLabel: pageLabels[view], objectType: null, objectId: null, objectTitle: null };
  })();
  return <main className={`app-shell${piDockCollapsed ? ' pi-collapsed' : ' pi-open'}${view === 'settings' ? ' settings-mode' : ''}${view === 'studio' ? ' studio-mode' : ''}`} style={{ '--pi-open-width': `${piDockWidth}px` } as React.CSSProperties}>
    <header className="topbar">
      <div className="brand"><img src={logoUrl} alt=""/><strong>WeMediaBuddy</strong></div>
      <div className="global-search"><input aria-label="全局搜索" placeholder="搜索领域、主题或项目" value={globalQuery} onChange={event=>setGlobalQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){setGlobalQuery('');setGlobalResults([]);}else if(event.key==='Enter'&&globalResults[0]){event.preventDefault();openGlobalResult(globalResults[0]);}}}/>{globalResults.length>0&&<div role="listbox" aria-label="全局搜索结果">{globalResults.map(item=><button key={`${item.kind}:${item.id}`} onClick={()=>openGlobalResult(item)}><small>{item.kind==='domain'?'领域':item.kind==='topic'?'主题':'项目'}</small><span>{item.title}</span></button>)}</div>}</div>
      {view === 'settings' && <span className="topbar-page-title">设置</span>}
      {view === 'studio' && <><span className="studio-topbar-crumb">创作 / <b>{studioSelectedId ? '编辑项目' : '项目库'}</b></span><div className="studio-topbar-actions"><button onClick={() => { setStudioSelectedId(null); window.setTimeout(() => window.dispatchEvent(new CustomEvent('studio-import-request')), 0); }}>导入已有稿件</button><button onClick={() => setPiDockCollapsed(false)}>和 Pi 讨论</button></div></>}
      <div className="titlebar-actions">
        <button aria-label="最小化窗口" onClick={() => void window.wmb.windowControl('minimize')}>−</button>
        <button aria-label="最大化或还原窗口" onClick={() => void window.wmb.windowControl('maximize')}>□</button>
        <button className="window-close" aria-label="关闭窗口" onClick={() => void window.wmb.windowControl('close')}>×</button>
      </div>
    </header>
    <aside className="sidebar"><div><nav aria-label="工作流"><div className="nav-group-label">工作流</div><button className={view === 'today' ? 'active' : ''} onClick={() => navigate('today')} title="今日"><Icon name="today"/><span>今日</span></button>{nav.slice(1).map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)} title={item.label}><Icon name={item.id}/><span>{item.label}</span></button>)}</nav><nav aria-label="知识资产"><div className="nav-group-label">知识资产</div><button className={view==='knowledge'||view==='topic'||view==='compose'?'active':''} onClick={()=>navigate('knowledge')} title="知识系统"><Icon name="library"/><span>知识系统</span></button><button className={view === 'library' ? 'active' : ''} onClick={() => navigate('library')} title="资料库"><Icon name="library"/><span>资料库</span></button><button className={view === 'canvas' ? 'active' : ''} onClick={() => navigate('canvas')} title="关系画布"><Icon name="library"/><span>关系画布</span></button></nav></div><nav className="sidebar-bottom"><button className={view === 'settings' ? 'active' : ''} onClick={() => navigate('settings')} title="设置"><Icon name="settings"/><span>设置</span></button></nav></aside>
    <section className="workspace">
      {view === 'today' && <TodayView today={today} refresh={refreshToday} openStudio={() => navigate('studio')} openLibrary={() => navigate('library')} openPublish={() => navigate('publish')} publications={publications} selectedItems={todaySelectedItems} onSelectionChange={setTodaySelectedItems} planDate={planDate}/>}
      {view==='knowledge'&&<DomainMapView selectedDomainId={knowledgeDomainId} onSelectDomain={setKnowledgeDomainId} onOpenTopic={id=>{setKnowledgeTopicId(id);navigate('topic');}}/>}
      {view==='topic'&&knowledgeTopicId&&<TopicDossierView topicId={knowledgeTopicId} onBack={()=>navigate('knowledge')} onOpenCanvas={canvasId=>{setCreativeContext(current=>current?.canvasId===canvasId?current:null);navigate('canvas');}}/>}
      {view === 'library' && <LibraryView rankingContext={rankingContext} onRankingContextChange={setRankingContext}/>}
      {view === 'canvas' && <KnowledgeCanvasView initialSelection={creativeContext} initialCanvasId={creativeContext?.canvasId} onContextChange={setCanvasContext} onDiscuss={()=>setPiDockCollapsed(false)} onCompose={(item)=>{setCreativeContext(item);setPiDockCollapsed(false);navigate('compose');}}/>}
      {view==='compose'&&creativeContext&&<CreativeComposerView context={creativeContext} onBack={()=>navigate('canvas')} onDiscuss={()=>setPiDockCollapsed(false)} onGenerate={()=>{setPiDockCollapsed(false);window.setTimeout(()=>window.dispatchEvent(new CustomEvent('wmb-pi-generate',{detail:'请基于当前创作组合生成一份可编辑创作简报，保存后回读简报 ID、revision、标题、核心判断、为什么现在和结构；不要生成正文。'})),0);}} onProject={projectId=>{setStudioSelectedId(projectId);navigate('studio');}}/>}
      {view === 'studio' && <LongTermStudioView openPublish={() => navigate('publish')} selectedId={studioSelectedId} onSelect={setStudioSelectedId} onContext={setStudioContext} planDate={planDate}/>}
      {view === 'publish' && <PublishView publications={publications} refresh={refreshPublications} openStudio={() => navigate('studio')} takeover={() => void window.wmb.startBrowser().then(refreshSettings)} selectedId={publishSelectedId} onSelect={setPublishSelectedId}/>}
      {view === 'results' && <ResultsView publications={publications} refresh={refreshPublications} planDate={planDate}/>}
      {view === 'settings' && <SettingsView dataRoot={dataRoot} settings={settings} browserChoice={browserChoice} setBrowserChoice={setBrowserChoice} refresh={refreshSettings} theme={theme} setTheme={setTheme} back={() => navigate('today')}/>}
    </section>
    {view !== 'settings' && <PiDock collapsed={piDockCollapsed} toggle={() => setPiDockCollapsed((value) => !value)} configured={settings?.pi.configured ?? false} context={piContext} resize={resizePiDock} resetWidth={resetPiDockWidth}/>}
    <footer className="status-bar">
      <div className="status-bar-left">
        <span className="status-item" data-phase={piPhase}><span className="status-dot"/>{piStatusText}</span>
        <span className="status-item"><span className={`status-dot ${settings?.mcp?.status === 'ready' ? 'ok' : 'idle'}`}/>{settings?.mcp?.status === 'ready' ? 'MCP 已连接' : 'MCP 未连接'}</span>
        <span className="status-item"><span className={`status-dot ${settings?.browser?.status === 'ready' ? 'ok' : 'idle'}`}/>{settings?.browser?.status === 'ready' ? '浏览器已连接' : '浏览器未启动'}</span>
      </div>
      <div className="status-bar-right">
        <button type="button" className="status-theme" title={theme === 'dark' ? '切换到白昼紫罗兰' : '切换到黑夜紫罗兰'} aria-label={theme === 'dark' ? '切换到白昼紫罗兰' : '切换到黑夜紫罗兰'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '☾'} <span>{theme === 'dark' ? '黑夜紫罗兰' : '白昼紫罗兰'}</span></button>
        <time dateTime={now.toISOString()}>{dateLabel}</time>
      </div>
    </footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
