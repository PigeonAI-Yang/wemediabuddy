import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { addKnowledgeCanvasNode,archiveKnowledgeContextPackage,createKnowledgeCanvas,createKnowledgeContextPackage,createKnowledgeRelation,getKnowledgeContextPackage,listKnowledgeContextPackages,previewKnowledgeContextPackage,recordKnowledgeContextUse } from '../src/main/knowledge-canvas.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-packages-'));let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const canvas=createKnowledgeCanvas(db,{title:'精确选包画布'}),nodes=[];
  for(let index=0;index<6;index++)nodes.push(addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'note',noteTitle:index===5?'未选哨兵':`对象 ${index+1}`,noteText:`快照 ${index+1}`,x:index*260,y:20}));
  const kept=createKnowledgeRelation(db,{canvasId:canvas.id,fromNodeId:nodes[0].id,toNodeId:nodes[1].id,relationType:'supports'});
  const excludedRelation=createKnowledgeRelation(db,{canvasId:canvas.id,fromNodeId:nodes[1].id,toNodeId:nodes[2].id,relationType:'contradicts'});
  const input={canvasId:canvas.id,nodeIds:nodes.map(node=>node.id),excludedNodeIds:[nodes[5].id],excludedRelationIds:[excludedRelation.id]};
  const preview=previewKnowledgeContextPackage(db,input);
  if(preview.items.length!==5||preview.relations.length!==1||preview.relations[0].id!==kept.id||preview.excluded.length!==2||preview.overLimit)throw new Error('preview inclusion/exclusion mismatch');
  const v1=createKnowledgeContextPackage(db,{...input,name:'复用选包',objective:'验证静态版本'});
  if(JSON.stringify(preview.items.map(item=>item.nodeId))!==JSON.stringify(v1.manifest.items.map(item=>item.nodeId))||v1.manifest.excluded.length!==2)throw new Error('saved manifest differs from preview');
  db.prepare("UPDATE knowledge_canvas_nodes SET note_text='后来修改',revision=revision+1 WHERE id=?").run(nodes[0].id);
  const v2=createKnowledgeContextPackage(db,{...input,name:'复用选包',objective:'第二静态版本',familyId:v1.familyId});
  const reread=getKnowledgeContextPackage(db,v1.id);
  if(v2.versionNumber!==2||reread.versions.length!==2||reread.items.find(item=>item.nodeId===nodes[0].id).snapshot.body!=='快照 1')throw new Error('static version history drifted');
  const use=recordKnowledgeContextUse(db,{requestId:'package-management-use',packageId:v2.id,expectedRevision:v2.revision,purpose:'discussion'});
  if(JSON.stringify(use.manifest.items.map(item=>item.nodeId))!==JSON.stringify(v2.manifest.items.map(item=>item.nodeId))||use.manifest.excluded.length!==2)throw new Error('actual manifest differs from saved preview');
  const listed=listKnowledgeContextPackages(db,{limit:1});
  if(listed.total!==2||listed.items.length!==1||!listed.hasMore)throw new Error('package list paging failed');
  const archived=archiveKnowledgeContextPackage(db,{id:v1.id,expectedRevision:v1.revision});
  let stale=false;try{archiveKnowledgeContextPackage(db,{id:v1.id,expectedRevision:v1.revision});}catch(error){stale=String(error).includes('PACKAGE_NOT_FOUND')||String(error).includes('REVISION_CONFLICT');}
  if(!archived.archived||!stale||listKnowledgeContextPackages(db,{archived:true}).total!==1)throw new Error('package archive failed');
  const huge=addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'note',noteTitle:'超大对象',noteText:'x'.repeat(31000),x:0,y:300});
  const oversized=previewKnowledgeContextPackage(db,{canvasId:canvas.id,nodeIds:[huge.id]});
  let blocked=false;try{createKnowledgeContextPackage(db,{canvasId:canvas.id,nodeIds:[huge.id],name:'超限',objective:'必须拒绝'});}catch(error){blocked=String(error).includes('PACKAGE_TOO_LARGE');}
  if(!oversized.overLimit||!blocked||listKnowledgeContextPackages(db).total!==1)throw new Error('oversize package was written');
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
