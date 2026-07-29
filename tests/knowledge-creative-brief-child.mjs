import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { addKnowledgeCanvasNode,createCreativeBriefIdempotent,createKnowledgeCanvas,getCreativeBriefForContext,updateCreativeBriefIdempotent } from '../src/main/knowledge-canvas.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-brief-'));let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const canvas=createKnowledgeCanvas(db,{title:'创作组合'}),nodes=[];
  for(const [index,title] of ['主主题判断','受众需求','当前变化','历史方法','核心证据','反方材料'].entries()){
    nodes.push(addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'note',noteTitle:title,noteText:`内容 ${index}`,x:index*250,y:20}));
  }
  const createInput={requestId:'brief-create',canvasId:canvas.id,nodeIds:nodes.map(node=>node.id),selectionMode:'selected',title:'发行体系正在形成',coreJudgment:'维护者承担发行角色',whyNow:'出现可观察的新证据',structure:['旧认知','新变化','证据','机会','边界'],evidenceNodeIds:nodes.map(node=>node.id)};
  const created=createCreativeBriefIdempotent(db,createInput),replayed=createCreativeBriefIdempotent(db,{...createInput,title:'重试不改标题'});
  if(created.data.id!==replayed.data.id||!replayed.replayed||db.prepare('SELECT count(*) AS count FROM creative_briefs').get().count!==1)throw new Error('brief create replay failed');
  let outside=false;try{updateCreativeBriefIdempotent(db,{requestId:'outside',id:created.data.id,expectedRevision:1,title:'标题',coreJudgment:'判断',whyNow:'现在',structure:['一步'],evidenceNodeIds:['outside']});}catch(error){outside=String(error).includes('BRIEF_EVIDENCE_OUTSIDE_CONTEXT');}
  if(!outside)throw new Error('outside evidence entered brief');
  const updated=updateCreativeBriefIdempotent(db,{requestId:'brief-update',id:created.data.id,expectedRevision:1,title:'用户修改后的标题',coreJudgment:'用户确认的新判断',whyNow:'证据刚刚出现',structure:['结论','证据','反证'],evidenceNodeIds:[nodes[4].id,nodes[5].id],status:'confirmed'});
  let stale=false;try{updateCreativeBriefIdempotent(db,{requestId:'brief-stale',id:created.data.id,expectedRevision:1,title:'旧写入',coreJudgment:'旧',whyNow:'旧',structure:['旧'],evidenceNodeIds:[]});}catch(error){stale=String(error).includes('REVISION_CONFLICT');}
  const read=getCreativeBriefForContext(db,{canvasId:canvas.id,nodeIds:nodes.map(node=>node.id)});
  if(!stale||updated.data.revision!==2||read.status!=='confirmed'||read.title!=='用户修改后的标题'||read.evidenceNodeIds.length!==2)throw new Error('brief update/readback failed');
  if(db.prepare('SELECT count(*) AS count FROM knowledge_context_packages').get().count!==0||db.prepare('SELECT count(*) AS count FROM knowledge_context_uses').get().count!==0)throw new Error('direct brief created package rows');
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
