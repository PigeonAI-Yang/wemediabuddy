import { useEffect,useState } from 'react';

const typeLabels:Record<string,string>={
  topic:'长期主题',source:'证据',plan_item:'受众需求',note:'当前变化',method_finding:'历史方法',
  review:'复盘',content_project:'历史内容',publication:'发布',metric_snapshot:'指标'
};

export function CreativeComposerView({context,onBack,onDiscuss,onGenerate,onProject}:{
  context:{canvasId:string;nodeIds:string[];mode:'current_page'|'selected';title:string};onBack:()=>void;onDiscuss:()=>void;onGenerate:()=>void;onProject:(projectId:string)=>void;
}){
  const [pack,setPack]=useState<any>(null),[brief,setBrief]=useState<any>(null),[message,setMessage]=useState('');
  const load=async()=>{setPack(await window.wmb.previewKnowledgeContextPackage({canvasId:context.canvasId,nodeIds:context.nodeIds}));setBrief(await window.wmb.getCreativeBriefForContext({canvasId:context.canvasId,nodeIds:context.nodeIds}));};
  useEffect(()=>{void load();const timer=window.setInterval(()=>void window.wmb.getCreativeBriefForContext({canvasId:context.canvasId,nodeIds:context.nodeIds}).then(setBrief),3000);return()=>window.clearInterval(timer);},[context.canvasId,context.nodeIds.join(',')]);
  const save=async(event:React.FormEvent<HTMLFormElement>,status:'draft'|'confirmed'='draft')=>{
    event.preventDefault();if(!pack)return;const data=new FormData(event.currentTarget);
    const input={requestId:crypto.randomUUID(),title:String(data.get('title')),coreJudgment:String(data.get('coreJudgment')),
      whyNow:String(data.get('whyNow')),structure:String(data.get('structure')).split('\n'),evidenceNodeIds:data.getAll('evidenceNodeIds').map(String)};
    const result=brief
      ? await window.wmb.updateCreativeBrief({...input,id:brief.id,expectedRevision:brief.revision,status})
      : await window.wmb.createCreativeBrief({...input,canvasId:context.canvasId,nodeIds:context.nodeIds,selectionMode:context.mode});
    setBrief(result.data);setMessage(status==='confirmed'?'简报已确认':'简报已保存');return result.data;
  };
  const enterProject=async(button:HTMLButtonElement)=>{
    const form=button.form;if(!form)return;
    const confirmed=brief?.status==='confirmed'?brief:await save({preventDefault(){},currentTarget:form} as React.FormEvent<HTMLFormElement>,'confirmed');
    if(!confirmed)return;
    const result=await window.wmb.createProjectFromBrief({requestId:crypto.randomUUID(),briefId:confirmed.id,expectedRevision:confirmed.revision});
    onProject(result.data.project.id);
  };
  if(!pack)return <section className="composer-page"><p>正在读取当前创作上下文…</p></section>;
  const topics=pack.items.filter((item:any)=>item.objectType==='topic');
  const contradicted=new Set(pack.relations.filter((item:any)=>item.relationType==='contradicts').flatMap((item:any)=>[item.fromNodeId,item.toNodeId]));
  return <section className="composer-page">
    <header className="composer-header"><div><small>知识系统 / 创作组合台</small><h1>{context.title}</h1><p>{context.mode==='selected'?`使用已选 ${pack.items.length} 项`:`使用当前页 ${pack.items.length} 项`}。</p></div><div><button onClick={onBack}>返回关系画布</button><button onClick={onDiscuss}>和 Pi 讨论</button><button className="primary-button" onClick={onGenerate}>让 Pi 生成简报</button></div></header>
    <div className="composer-shell">
      <aside className="composer-combination"><h2>本次创作组合</h2><p>{pack.items.length} 项资产 · {pack.relations.length} 条关系 · {pack.estimatedCharacters} 字符</p>
        <div className="composer-slot"><label>主主题</label>{topics[0]?<b>{topics[0].snapshot.title}</b>:<span>当前选择未包含主题</span>}</div>
        <div className="composer-slot"><label>关联主题</label>{topics.slice(1).map((item:any)=><b key={item.nodeId}>{item.snapshot.title}</b>)}{topics.length<2&&<span>无</span>}</div>
        {pack.items.filter((item:any)=>item.objectType!=='topic').map((item:any)=><div className={`composer-slot${contradicted.has(item.nodeId)?' counter':''}`} key={item.nodeId}><label>{contradicted.has(item.nodeId)?'反方材料':typeLabels[item.objectType]??item.objectType}</label><b>{item.snapshot.title}</b><span>{item.snapshot.body||'暂无摘要'}</span></div>)}
      </aside>
      <form className="composer-brief" key={brief?.revision??'new'} onSubmit={event=>void save(event)}>
        <div className="composer-brief-head"><div><small>{brief?'可编辑创作简报':'新创作简报'}</small><strong>{brief?`第 ${brief.revision} 版 · ${brief.status==='confirmed'?'已确认':'草稿'}`:'直接关联当前证据'}</strong></div><button className="primary-button" type="submit">保存简报</button></div>
        <label>建议标题<input name="title" required defaultValue={brief?.title??context.title}/></label>
        <label>本次核心判断<textarea name="coreJudgment" required rows={5} defaultValue={brief?.coreJudgment??''}/></label>
        <label>为什么现在值得讲<textarea name="whyNow" required rows={4} defaultValue={brief?.whyNow??''}/></label>
        <fieldset><legend>本次证据</legend>{pack.items.map((item:any)=><label className="composer-evidence" key={item.nodeId}><input type="checkbox" name="evidenceNodeIds" value={item.nodeId} defaultChecked={!brief||brief.evidenceNodeIds.includes(item.nodeId)}/><span>{item.snapshot.title}</span><small>{typeLabels[item.objectType]??item.objectType}</small></label>)}</fieldset>
        <label>内容结构（每行一步）<textarea name="structure" required rows={7} defaultValue={(brief?.structure??['旧认知','当前变化','关键证据','创作者机会','边界与反证']).join('\n')}/></label>
        <footer><span>{message||'证据直接来自当前页面选择'}</span><button type="button" disabled={!brief} onClick={event=>void enterProject(event.currentTarget)}>确认简报并进入正文</button></footer>
      </form>
      <aside className="composer-assets"><h2>可替换资产</h2><p>不会自动扩展到未选知识。</p>{pack.items.map((item:any)=><article key={item.nodeId}><small>{typeLabels[item.objectType]??item.objectType}</small><b>{item.snapshot.title}</b><span>{item.snapshot.body||'暂无摘要'}</span></article>)}</aside>
    </div>
  </section>;
}
