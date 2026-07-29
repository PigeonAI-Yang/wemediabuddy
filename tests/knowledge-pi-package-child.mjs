import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { addKnowledgeCanvasNode,createKnowledgeCanvas,createKnowledgeContextPackage,createKnowledgeRelation,createKnowledgeSuggestionIdempotent,decideKnowledgeSuggestionIdempotent,getKnowledgeCanvas,recordKnowledgeContextUse } from '../src/main/knowledge-canvas.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-pi-package-'));let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const canvas=createKnowledgeCanvas(db,{title:'Pi 精确选包'});
  const first=addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'note',noteTitle:'包含对象',noteText:'正文',x:20,y:20});
  const excluded=addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'note',noteTitle:'排除对象',noteText:'不可读取',x:300,y:20});
  const pack=createKnowledgeContextPackage(db,{canvasId:canvas.id,name:'只读选包',objective:'精确读取',nodeIds:[first.id,excluded.id],excludedNodeIds:[excluded.id]});
  const useInput={requestId:'same-use',packageId:pack.id,expectedRevision:pack.revision,purpose:'creation'};
  const use1=recordKnowledgeContextUse(db,useInput),use2=recordKnowledgeContextUse(db,useInput);
  if(use1.id!==use2.id||!use2.replayed||use1.manifest.items[0].nodeId!==first.id||use1.manifest.excluded[0].id!==excluded.id)throw new Error('use receipt is not exact or idempotent');
  if(db.prepare('SELECT count(*) AS count FROM knowledge_context_uses').get().count!==1)throw new Error('duplicate use was written');

  const suggestedNode=createKnowledgeSuggestionIdempotent(db,{requestId:'suggest-node',canvasId:canvas.id,kind:'node',payload:{objectType:'note',noteTitle:'Pi 新判断',noteText:'待确认',x:20,y:240}});
  const replayedNode=createKnowledgeSuggestionIdempotent(db,{requestId:'suggest-node',canvasId:canvas.id,kind:'node',payload:{objectType:'note',noteTitle:'不同内容',x:0,y:0}});
  if(suggestedNode.data.id!==replayedNode.data.id||!replayedNode.replayed||getKnowledgeCanvas(db,canvas.id).nodes.some(node=>node.object.title==='Pi 新判断'))throw new Error('suggested node entered knowledge before confirmation');
  const confirmed=decideKnowledgeSuggestionIdempotent(db,{requestId:'confirm-node',id:suggestedNode.data.id,expectedRevision:1,decision:'confirm'});
  const confirmedReplay=decideKnowledgeSuggestionIdempotent(db,{requestId:'confirm-node',id:suggestedNode.data.id,expectedRevision:1,decision:'confirm'});
  if(!confirmed.data.created||confirmed.data.created.id!==confirmedReplay.data.created.id||!confirmedReplay.replayed)throw new Error('node confirmation was not atomic/idempotent');

  const nodes=getKnowledgeCanvas(db,canvas.id).nodes;
  const rejected=createKnowledgeSuggestionIdempotent(db,{requestId:'reject-relation',canvasId:canvas.id,kind:'relation',payload:{fromNodeId:nodes[0].id,toNodeId:nodes[1].id,relationType:'supports'}});
  decideKnowledgeSuggestionIdempotent(db,{requestId:'reject-relation-decision',id:rejected.data.id,expectedRevision:1,decision:'reject'});
  if(getKnowledgeCanvas(db,canvas.id).relations.length!==0)throw new Error('rejected suggestion entered confirmed knowledge');
  const accepted=createKnowledgeSuggestionIdempotent(db,{requestId:'accept-relation',canvasId:canvas.id,kind:'relation',payload:{fromNodeId:nodes[0].id,toNodeId:nodes[1].id,relationType:'supports'}});
  decideKnowledgeSuggestionIdempotent(db,{requestId:'accept-relation-decision',id:accepted.data.id,expectedRevision:1,decision:'confirm'});
  const final=getKnowledgeCanvas(db,canvas.id);
  if(final.suggestions.length||final.relations.length!==1||final.relations[0].state!=='confirmed')throw new Error('confirmed relation did not enter knowledge exactly once');
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
