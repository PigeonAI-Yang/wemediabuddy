import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CommandDispatcher,createCommandEnvelope} from '../src/main/command-dispatcher.ts';
import {migrateDatabase} from '../src/main/db/migrations.ts';
import {saveAccount} from '../src/main/accounts.ts';
import {savePlatformVersion} from '../src/main/content.ts';
import {savePublicationMetricSnapshot} from '../src/main/metrics.ts';
import {createPublication} from '../src/main/publishing.ts';
import {saveReview} from '../src/main/reviews.ts';
import {upsertSource} from '../src/main/sources.ts';
import {upsertKnowledgeTopic} from '../src/main/knowledge.ts';
import {
  addKnowledgeCanvasNode,createContentProjectFromBrief,createCreativeBrief,createKnowledgeCanvas,
  decideKnowledgeSuggestion,getCreativeBriefLineage,getKnowledgeCanvas,updateCreativeBrief
} from '../src/main/knowledge-canvas.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-lineage-'));let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const workspaceNow=new Date().toISOString(),workspaceId='workspace-lineage-test';
  db.prepare("INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES('workspace_id',?,?,?,1)").run(workspaceId,workspaceNow,workspaceNow);
  const dispatcher=new CommandDispatcher(db,{workspaceId,rootPath:directory,runtimeEpoch:'lineage-test'});
  const dispatch=(command,requestId,input,entityType,execute)=>{
    const envelope=createCommandEnvelope({workspaceId,runtimeEpoch:'lineage-test',command,requestId,input,boundIdentity:{entityType},actor:{type:'owner_ui',id:'renderer'}});
    return dispatcher.dispatch(envelope,()=>{const data=execute(db,envelope.input);return {data,entityType,entityId:data?.id??data?.project?.id,afterRevision:data?.revision};});
  };
  const source=upsertSource(db,{title:'直接证据',originalUrl:'https://example.com/direct',summary:'证据正文',categories:[],keywords:[],valueJudgment:'值得',ipRelevance:'相关',creationAngles:'角度',recommendedPlatforms:['x'],recommendedFormats:['text'],timeliness:'now',priority:1,evidence:'原文'});
  const topic=upsertKnowledgeTopic(db,{title:'长期主题',canonicalKey:'long-topic'});
  const canvas=createKnowledgeCanvas(db,{title:'追溯画布'});
  const topicNode=addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'topic',objectId:topic.id,x:20,y:20});
  const sourceNode=addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:'source',objectId:source.id,x:300,y:20});
  const briefInput={canvasId:canvas.id,nodeIds:[topicNode.id,sourceNode.id],selectionMode:'selected',title:'直接简报',coreJudgment:'核心判断',whyNow:'现在值得讲',structure:['结论','证据','边界'],evidenceNodeIds:[sourceNode.id]};
  const created=dispatch('knowledge.creative_brief_create','brief',briefInput,'creative_brief',createCreativeBrief);
  const confirmed=dispatch('knowledge.creative_brief_update','confirm',{id:created.data.id,expectedRevision:1,title:'直接简报',coreJudgment:'核心判断',whyNow:'现在值得讲',structure:['结论','证据','边界'],evidenceNodeIds:[sourceNode.id],status:'confirmed'},'creative_brief',updateCreativeBrief);
  const projectInput={briefId:created.data.id,expectedRevision:confirmed.data.revision};
  const linked=dispatch('knowledge.creative_brief_create_project','project',projectInput,'content_project',createContentProjectFromBrief);
  const replay=dispatch('knowledge.creative_brief_create_project','project',projectInput,'content_project',createContentProjectFromBrief);
  if(linked.receiptId!==replay.receiptId||linked.data.project.id!==replay.data.project.id||linked.data.project.sourceIds[0]!==source.id||linked.data.project.topicId!==topic.id)throw new Error('brief project linkage failed');
  const account=saveAccount(db,{platform:'x',accountKey:'@lineage',displayName:'lineage',loginState:'authenticated'});
  const core=linked.data.project.revisions[0];
  const platform=savePlatformVersion(db,{projectId:linked.data.project.id,contentVersionId:core.id,platform:'x',format:'text',body:'平台正文'});
  const publication=createPublication(db,{platformVersionId:platform.data.id,accountId:account.id});
  const now=new Date().toISOString();
  db.prepare(`UPDATE publications SET status='published',external_url=?,external_id=?,published_at=?,updated_at=?,revision=revision+1 WHERE id=?`).run('https://x.com/lineage/status/1','1',now,now,publication.data.id);
  const metric=savePublicationMetricSnapshot(db,{publicationId:publication.data.id,scheduledFor:now,sourceUrl:'https://x.com/lineage/status/1',capturedAt:now,normalized:{views:{status:'value',value:12,rawLabel:'12'}},raw:{views:{status:'value',value:12,rawLabel:'12'}}});
  const review=saveReview(db,{publicationId:publication.data.id,metricSnapshotIds:[metric.data.id],keep:['保留证据'],stop:['停止泛化'],change:['强化开头'],status:'final',findings:[{title:'先给结论',body:'下一篇先给结论'}]});
  if(!review.ok)throw new Error(review.error.message);
  const lineage=getCreativeBriefLineage(db,created.data.id);
  if(lineage.publications[0].id!==publication.data.id||lineage.metrics[0].id!==metric.data.id||lineage.reviews[0].id!==review.data.id||lineage.findings[0].id!==review.data.findings[0].id)throw new Error('lineage readback incomplete');
  const pending=getKnowledgeCanvas(db,canvas.id).suggestions;
  if(pending.length!==2)throw new Error('review return suggestions missing');
  const before=getKnowledgeCanvas(db,canvas.id);
  const decided=dispatch('knowledge.suggestion_decide','confirm-return',{id:pending[1].id,expectedRevision:pending[1].revision,decision:'confirm'},'knowledge_suggestion',decideKnowledgeSuggestion);
  const after=getKnowledgeCanvas(db,canvas.id);
  if(!decided.data.created.relations?.length||after.nodes.length!==before.nodes.length+1||after.relations.length!==before.relations.length+1)throw new Error('confirmed method return not formalized');
  if(db.prepare('SELECT count(*) count FROM knowledge_context_packages').get().count!==0||db.prepare('SELECT count(*) count FROM knowledge_context_uses').get().count!==0)throw new Error('lineage recreated package rows');
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
