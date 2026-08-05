import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandDispatcher, createCommandEnvelope } from '../src/main/command-dispatcher.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { addKnowledgeCanvasNode,createCreativeBrief,createKnowledgeCanvas,getCreativeBriefForContext,updateCreativeBrief } from '../src/main/knowledge-canvas.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-brief-'));let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const now=new Date().toISOString(),workspaceId='workspace-brief-test';
  db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId,now,now);
  const dispatcher=new CommandDispatcher(db,{workspaceId,rootPath:directory,runtimeEpoch:'brief-test'});
  const dispatch=(command,requestId,input,entityType,execute)=>{
    const envelope=createCommandEnvelope({workspaceId,runtimeEpoch:'brief-test',command,requestId,input,boundIdentity:{entityType},actor:{type:'owner_ui',id:'renderer'}});
    return dispatcher.dispatch(envelope,()=>{const data=execute(db,envelope.input);return {data,entityType,entityId:data?.id,afterRevision:data?.revision};});
  };
  const canvas=createKnowledgeCanvas(db,{title:'创作组合'}),nodes=[];
  for(const [index,title] of ['主主题判断','受众需求','当前变化','历史方法','核心证据','反方材料'].entries()){
    nodes.push(addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'note',noteTitle:title,noteText:`内容 ${index}`,x:index*250,y:20}));
  }
  const createInput={canvasId:canvas.id,nodeIds:nodes.map(node=>node.id),selectionMode:'selected',title:'发行体系正在形成',coreJudgment:'维护者承担发行角色',whyNow:'出现可观察的新证据',structure:['旧认知','新变化','证据','机会','边界'],evidenceNodeIds:nodes.map(node=>node.id)};
  const created=dispatch('knowledge.creative_brief_create','brief-create',createInput,'creative_brief',createCreativeBrief),replayed=dispatch('knowledge.creative_brief_create','brief-create',createInput,'creative_brief',createCreativeBrief);
  if(created.receiptId!==replayed.receiptId||created.data.id!==replayed.data.id||db.prepare('SELECT count(*) AS count FROM creative_briefs').get().count!==1)throw new Error('brief create replay failed');
  const outside=dispatch('knowledge.creative_brief_update','outside',{id:created.data.id,expectedRevision:1,title:'标题',coreJudgment:'判断',whyNow:'现在',structure:['一步'],evidenceNodeIds:['outside']},'creative_brief',updateCreativeBrief);
  if(outside.ok||outside.error.code!=='BRIEF_EVIDENCE_OUTSIDE_CONTEXT')throw new Error('outside evidence entered brief');
  const updateInput={id:created.data.id,expectedRevision:1,title:'用户修改后的标题',coreJudgment:'用户确认的新判断',whyNow:'证据刚刚出现',structure:['结论','证据','反证'],evidenceNodeIds:[nodes[4].id,nodes[5].id],status:'confirmed'};
  const updated=dispatch('knowledge.creative_brief_update','brief-update',updateInput,'creative_brief',updateCreativeBrief);
  const stale=dispatch('knowledge.creative_brief_update','brief-stale',{...updateInput,title:'旧写入',expectedRevision:1},'creative_brief',updateCreativeBrief);
  const read=getCreativeBriefForContext(db,{canvasId:canvas.id,nodeIds:nodes.map(node=>node.id)});
  if(stale.ok||stale.error.code!=='REVISION_CONFLICT'||updated.data.revision!==2||read.status!=='confirmed'||read.title!=='用户修改后的标题'||read.evidenceNodeIds.length!==2)throw new Error('brief update/readback failed');
  if(db.prepare('SELECT count(*) AS count FROM knowledge_context_packages').get().count!==0||db.prepare('SELECT count(*) AS count FROM knowledge_context_uses').get().count!==0)throw new Error('direct brief created package rows');
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
