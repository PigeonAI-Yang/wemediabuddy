import { useEffect,useState } from 'react';

type DomainEditor={id?:string;revision?:number;title:string;description:string;status:'active'|'watching'|'dormant';topicIds:string[]};

export function DomainMapView({selectedDomainId,onSelectDomain,onOpenTopic}:{selectedDomainId:string|null;onSelectDomain:(id:string|null)=>void;onOpenTopic:(id:string)=>void}){
  const [page,setPage]=useState<any>({items:[],total:0});
  const [details,setDetails]=useState<Record<string,any>>({});
  const [topics,setTopics]=useState<any[]>([]);
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('');
  const [order,setOrder]=useState<'manual'|'recent'|'size'>('recent');
  const [mode,setMode]=useState<'map'|'list'>('map');
  const [editor,setEditor]=useState<DomainEditor|null>(null);
  const [opened,setOpened]=useState<any|null>(null);
  const [message,setMessage]=useState('');

  const refresh=async()=>{
    const next=await window.wmb.listKnowledgeDomains({query,status:status||undefined,order,limit:100});
    setPage(next);
    const loaded=await Promise.all(next.items.map((item:any)=>window.wmb.getKnowledgeDomain(item.id,{limit:100})));
    setDetails(Object.fromEntries(loaded.map(item=>[item.id,item])));
  };
  useEffect(()=>{void Promise.all([refresh(),window.wmb.listKnowledgeTopics({limit:100})]).then(([,items])=>setTopics(items));},[query,status,order]);
  useEffect(()=>{if(selectedDomainId&&details[selectedDomainId])setOpened(details[selectedDomainId]);},[selectedDomainId,details]);
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();if(!editor)return;
    const saved=editor.id
      ?await window.wmb.updateKnowledgeDomain({id:editor.id,expectedRevision:editor.revision!,title:editor.title,description:editor.description,status:editor.status,topicIds:editor.topicIds})
      :await window.wmb.createKnowledgeDomain({title:editor.title,description:editor.description,status:editor.status,topicIds:editor.topicIds});
    setEditor(null);onSelectDomain(saved.id);setMessage(`已保存领域“${saved.title}”`);await refresh();
  };
  const archive=async(domain:any)=>{
    if(!window.confirm(`归档领域“${domain.title}”？主题和资料不会被删除。`))return;
    await window.wmb.updateKnowledgeDomain({id:domain.id,expectedRevision:domain.revision,archived:true});
    setOpened(null);setMessage('领域已归档，主题和资料保持不变');await refresh();
  };
  const edit=(domain:any)=>setEditor({id:domain.id,revision:domain.revision,title:domain.title,description:domain.description,status:domain.status,topicIds:(details[domain.id]?.topics??[]).map((item:any)=>item.id)});
  const signal=(domain:any)=>domain.recentSourceCount?`近 7 天 +${domain.recentSourceCount} 条资料`:domain.lastChangedAt?`更新于 ${new Date(domain.lastChangedAt).toLocaleDateString('zh-CN')}`:'尚无变化';

  return <section className="ks-domains">
    <header className="ks-page-head"><div><small>知识系统</small><h1>领域地图</h1><p>管理长期关注版图，不被每天的新消息牵着走。</p></div><button className="primary-button" onClick={()=>setEditor({title:'',description:'',status:'active',topicIds:[]})}>建立领域</button></header>
    <div className="ks-domain-toolbar"><input aria-label="搜索领域或主题" placeholder="搜索领域、主题或判断" value={query} onChange={event=>setQuery(event.target.value)}/><select aria-label="领域状态" value={status} onChange={event=>setStatus(event.target.value)}><option value="">全部状态</option><option value="active">活跃</option><option value="watching">持续观察</option><option value="dormant">长期沉寂</option></select><select aria-label="领域排序" value={order} onChange={event=>setOrder(event.target.value as any)}><option value="recent">按近期变化</option><option value="size">按资产规模</option><option value="manual">按手工顺序</option></select><div className="ks-mode" role="group" aria-label="领域显示模式"><button className={mode==='map'?'active':''} onClick={()=>setMode('map')}>地图</button><button className={mode==='list'?'active':''} onClick={()=>setMode('list')}>列表</button></div></div>
    {message&&<div className="ks-message" role="status">{message}</div>}
    <div className={`ks-domain-content ${mode}`}>
      {!page.items.length&&<div className="ks-empty"><h2>建立第一个长期领域</h2><p>领域只组织已有主题，不复制资料，也不产生自动评分。</p></div>}
      {page.items.map((domain:any)=><section className="ks-domain-row" key={domain.id}><div className="ks-domain-title"><button onClick={()=>{onSelectDomain(domain.id);setOpened(details[domain.id]??domain);}}><h2>{domain.title}</h2></button><p>{domain.description||'尚未填写领域说明'}</p><small>{domain.topicCount} 个主题 · {domain.sourceCount} 条资料</small><div><button onClick={()=>edit(domain)}>编辑</button><button onClick={()=>void archive(domain)}>归档</button></div></div><div className="ks-clusters">
        {(details[domain.id]?.topics??[]).slice(0,mode==='map'?6:100).map((topic:any)=><button className={`ks-cluster ${topic.status}`} key={topic.id} onClick={()=>{onSelectDomain(domain.id);onOpenTopic(topic.id);}}><header><i/><b>{topic.title}</b><span>{topic.lastSeenAt?new Date(topic.lastSeenAt).toLocaleDateString('zh-CN'):'尚无资料'}</span></header><p>{topic.summary||'尚未形成稳定判断'}</p><footer><span>{topic.sourceCount} 条资料</span><span>{topic.opportunityCount} 个机会</span></footer></button>)}
        {domain.topicCount>(details[domain.id]?.topics?.length??0)&&<button className="ks-more" onClick={()=>setOpened(details[domain.id])}>查看全部 {domain.topicCount} 个主题</button>}
        {!domain.topicCount&&<button className="ks-more" onClick={()=>edit(domain)}>＋ 把现有主题加入领域</button>}
      </div><aside><b>{signal(domain)}</b><span className={`pill-status ${domain.status==='active'?'green':domain.status==='watching'?'amber':'gray'}`}><span className="dot"/>{domain.status==='active'?'活跃':domain.status==='watching'?'持续观察':'长期沉寂'}</span></aside></section>)}
    </div>
    {opened&&<div className="ks-overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget){setOpened(null);onSelectDomain(null);}}}><section className="ks-domain-detail" role="dialog" aria-modal="true" aria-label={`${opened.title}主题列表`}><header><div><small>领域</small><h2>{opened.title}</h2><p>{opened.total} 个主题，按手工顺序与最近变化稳定分页。</p></div><button aria-label="关闭领域详情" onClick={()=>{setOpened(null);onSelectDomain(null);}}>×</button></header><div>{opened.topics.map((topic:any)=><button key={topic.id} onClick={()=>onOpenTopic(topic.id)}><b>{topic.title}</b><span>{topic.sourceCount} 条资料 · {topic.opportunityCount} 个机会</span></button>)}</div>{opened.hasMore&&<button onClick={async()=>{const next=await window.wmb.getKnowledgeDomain(opened.id,{limit:100,offset:opened.topics.length});setOpened({...next,topics:[...opened.topics,...next.topics]});}}>加载更多</button>}</section></div>}
    {editor&&<div className="ks-overlay"><form className="ks-domain-editor" role="dialog" aria-modal="true" aria-label={editor.id?'编辑领域':'建立领域'} onSubmit={save}><header><h2>{editor.id?'编辑领域':'建立领域'}</h2><button type="button" aria-label="关闭领域编辑" onClick={()=>setEditor(null)}>×</button></header><label>领域名称<input required autoFocus value={editor.title} onChange={event=>setEditor({...editor,title:event.target.value})}/></label><label>说明<textarea rows={3} value={editor.description} onChange={event=>setEditor({...editor,description:event.target.value})}/></label><label>状态<select value={editor.status} onChange={event=>setEditor({...editor,status:event.target.value as DomainEditor['status']})}><option value="active">活跃</option><option value="watching">持续观察</option><option value="dormant">长期沉寂</option></select></label><fieldset><legend>包含主题</legend>{topics.map(topic=><label key={topic.id}><input type="checkbox" checked={editor.topicIds.includes(topic.id)} onChange={event=>setEditor({...editor,topicIds:event.target.checked?[...editor.topicIds,topic.id]:editor.topicIds.filter(id=>id!==topic.id)})}/><span>{topic.title}</span><small>{topic.sourceCount} 条资料</small></label>)}</fieldset><footer><button type="button" onClick={()=>setEditor(null)}>取消</button><button className="primary-button">保存领域</button></footer></form></div>}
  </section>;
}

const dossierLabels:Record<string,string>={sources:'资料',judgments:'当前判断',audience_demands:'受众需求',counter_evidence:'反证',content_history:'内容历史',metrics:'指标',reviews:'复盘',method_findings:'方法结论'};

export function TopicDossierView({topicId,onBack,onOpenCanvas}:{topicId:string;onBack:()=>void;onOpenCanvas:(canvasId:string)=>void}){
  const [page,setPage]=useState<any>(null);
  const [items,setItems]=useState<any[]>([]);
  const [category,setCategory]=useState('');
  const [mode,setMode]=useState<'timeline'|'grouped'>('timeline');
  const [canvases,setCanvases]=useState<any[]>([]);
  const [canvasId,setCanvasId]=useState('new');
  const [newCanvasTitle,setNewCanvasTitle]=useState('');
  const [message,setMessage]=useState('');
  const load=async(offset=0)=>{
    const next=await window.wmb.getKnowledgeTopicDossier({topicId,category:category||undefined,limit:50,offset});
    setPage(next);setItems(current=>offset?[...current,...next.items]:next.items);
  };
  useEffect(()=>{
    setItems([]);void load();
    const timer=window.setInterval(()=>void load(),5000);
    return()=>window.clearInterval(timer);
  },[topicId,category]);
  useEffect(()=>{void window.wmb.listKnowledgeCanvases().then(list=>{setCanvases(list);setCanvasId(list.find(canvas=>canvas.topicId===topicId)?.id??'new');});},[topicId]);
  const place=async(item:any)=>{
    try{
      let target=canvasId;
      if(target==='new'){
        const canvas=await window.wmb.createKnowledgeCanvas({title:newCanvasTitle.trim()||`${page.topic.title} 工作台`,topicId});
        target=canvas.id;setCanvases(await window.wmb.listKnowledgeCanvases());setCanvasId(target);
      }
      const canvas=await window.wmb.getKnowledgeCanvas(target);
      await window.wmb.addKnowledgeCanvasNode({canvasId:target,objectType:item.objectType,objectId:item.objectId,x:80+canvas.nodes.length%4*280,y:90+Math.floor(canvas.nodes.length/4)*190});
      setMessage(`已把“${item.title}”作为引用放入画布`);
    }catch(error){setMessage(String(error).includes('UNIQUE')?'该资产已在目标画布中':String(error));}
  };
  const renderItem=(item:any)=><article className="ks-topic-asset" key={`${item.category}:${item.objectId}`}><i aria-hidden="true"/><div><small>{dossierLabels[item.category]}</small><h3>{item.title}</h3><p>{item.body||'暂无补充内容'}</p><time>{new Date(item.occurredAt).toLocaleString('zh-CN')}</time></div><button onClick={()=>void place(item)}>放入画布</button></article>;
  const groups=Object.keys(dossierLabels).map(key=>[key,items.filter(item=>item.category===key)] as const).filter(([,values])=>values.length);
  return <section className="ks-topic-route">
    <header className="ks-topic-head"><button onClick={onBack}>← 领域地图</button><div><small>长期主题档案</small><h1>{page?.topic.title??'正在载入'}</h1><p>{page?.topic.summary||'围绕一个长期主题保存跨天事实、判断、创作与结果。'}</p></div><div className="ks-topic-place"><select aria-label="目标画布" value={canvasId} onChange={event=>setCanvasId(event.target.value)}><option value="new">新建主题画布</option>{canvases.map(canvas=><option key={canvas.id} value={canvas.id}>{canvas.title}</option>)}</select>{canvasId==='new'&&<input aria-label="新画布名称" placeholder={`${page?.topic.title??'主题'} 工作台`} value={newCanvasTitle} onChange={event=>setNewCanvasTitle(event.target.value)}/>}<button disabled={canvasId==='new'} onClick={()=>onOpenCanvas(canvasId)}>打开关系画布</button></div></header>
    <nav className="ks-topic-tabs" aria-label="主题资产分类"><button className={!category?'active':''} onClick={()=>setCategory('')}>全部 <span>{page?.total??0}</span></button>{Object.entries(dossierLabels).map(([key,label])=><button key={key} className={category===key?'active':''} onClick={()=>setCategory(key)}>{label} <span>{page?.counts?.[key]??0}</span></button>)}</nav>
    <div className="ks-topic-toolbar"><div role="group" aria-label="档案显示模式"><button className={mode==='timeline'?'active':''} onClick={()=>setMode('timeline')}>时间线</button><button className={mode==='grouped'?'active':''} onClick={()=>setMode('grouped')}>分组</button></div><span>{message}</span></div>
    <div className={`ks-topic-body ${mode}`}>
      {!items.length&&page&&<div className="ks-empty"><h2>这个分类还没有资产</h2><p>主题档案只展示已经写入业务对象的事实。</p></div>}
      {mode==='timeline'?items.map(renderItem):groups.map(([key,values])=><section className="ks-topic-group" key={key}><header><h2>{dossierLabels[key]}</h2><span>{values.length}</span></header>{values.map(renderItem)}</section>)}
      {page?.hasMore&&<button className="ks-load-more" onClick={()=>void load(items.length)}>加载更多</button>}
    </div>
  </section>;
}
