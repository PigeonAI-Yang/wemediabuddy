import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { saveAccount } from '../src/main/accounts.ts';
import { createContentProject,saveCoreVersion,savePlatformVersion } from '../src/main/content.ts';
import { addKnowledgeCanvasNode,createKnowledgeCanvas,getKnowledgeCanvas } from '../src/main/knowledge-canvas.ts';
import { getKnowledgeTopicDossier,recordKnowledgeBatch,upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { savePublicationMetricSnapshot } from '../src/main/metrics.ts';
import { saveCurrentPlan } from '../src/main/planning.ts';
import { createPublication } from '../src/main/publishing.ts';
import { saveReview } from '../src/main/reviews.ts';
import { upsertSource } from '../src/main/sources.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-dossier-'));let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const topicTitle='长期 Agent 主题',topic=upsertKnowledgeTopic(db,{title:topicTitle,summary:'跨天积累'});
  const sources=[];
  for(let index=0;index<2001;index++){
    const source=upsertSource(db,{originalUrl:`https://example.com/dossier/${index}`,title:`资料 ${index}`,summary:`摘要 ${index}`});sources.push(source);
    recordKnowledgeBatch(db,{items:[{sourceId:source.id,topic:{title:topicTitle},relation:index===2000?'contradicting':'primary'}]});
  }
  saveCurrentPlan(db,{planDate:'2026-07-29',timezone:'Asia/Shanghai',summary:'主题判断',items:[{topicId:topic.id,title:'Agent 机会',priority:1,whyNow:'生态变化',timeliness:'本周',targetAudience:'需要自动化的创作者',angle:'真实工作流',pointOfView:'Skill 正在成为发行单位',platforms:['x'],formats:['text'],titleGuidance:'标题',openingGuidance:'开头',structureGuidance:'结构',effortEstimate:'1h',sourceIds:[sources[0].id]}]});
  const project=createContentProject(db,{title:'主题内容项目',topicId:topic.id,sourceIds:[sources[0].id]});
  const core=saveCoreVersion(db,{projectId:project.id,body:'核心正文',expectedRevision:1});if(!core.ok)throw new Error(core.error.message);
  const platform=savePlatformVersion(db,{projectId:project.id,contentVersionId:core.data.id,platform:'x',format:'text',body:'平台正文'});if(!platform.ok)throw new Error(platform.error.message);
  const account=saveAccount(db,{platform:'x',accountKey:'@dossier',displayName:'dossier',loginState:'authenticated'});
  const publication=createPublication(db,{platformVersionId:platform.data.id,accountId:account.id});if(!publication.ok)throw new Error(publication.error.message);
  const now=new Date().toISOString(),publicationRow=db.prepare('SELECT revision FROM publications WHERE id=?').get(publication.data.id);
  db.prepare(`UPDATE publications SET status='published',external_url=?,external_id='1',published_at=?,prepared_body='平台正文',prepared_assets_json='[]',updated_at=?,revision=? WHERE id=?`)
    .run('https://x.com/dossier/status/1',now,now,publicationRow.revision+1,publication.data.id);
  const metric=savePublicationMetricSnapshot(db,{publicationId:publication.data.id,scheduledFor:now,sourceUrl:'https://x.com/dossier/status/1',capturedAt:now,normalized:{views:{status:'value',value:42}},raw:{views:'42'}});if(!metric.ok)throw new Error(metric.error.message);
  const review=saveReview(db,{publicationId:publication.data.id,metricSnapshotIds:[metric.data.id],keep:['保留证据'],stop:['停止空话'],change:['加强开头'],summary:'真实复盘',status:'final',findings:[{title:'先给结果',body:'开头先展示结果'}]});if(!review.ok)throw new Error(review.error.message);

  const pagingStarted=performance.now();
  const pages=[];for(let offset=0;offset<2000;offset+=100)pages.push(getKnowledgeTopicDossier(db,{topicId:topic.id,category:'sources',limit:100,offset}));
  const pagingMs=Math.round((performance.now()-pagingStarted)*10)/10,first=pages[0];
  const all=getKnowledgeTopicDossier(db,{topicId:topic.id,limit:100});
  if(first.total!==2000||pages.some((page,index)=>page.items.length!==100||page.hasMore!==(index<19)))throw new Error(`source dossier paging omitted items ${JSON.stringify({firstTotal:first.total,pageLengths:pages.map(page=>page.items.length),hasMore:pages.map(page=>page.hasMore),counts:first.counts})}`);
  for(const category of ['judgments','audience_demands','counter_evidence','content_history','metrics','reviews','method_findings'])if(all.counts[category]!==1)throw new Error(`missing dossier category ${category}`);

  const liveSourceId=first.items[0].objectId;
  db.prepare("UPDATE source_items SET summary='更新后摘要',revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(),liveSourceId);
  const refreshed=getKnowledgeTopicDossier(db,{topicId:topic.id,category:'sources',limit:100});
  if(!refreshed.items.some(item=>item.objectId===liveSourceId&&item.body==='更新后摘要'))throw new Error('dossier copied stale source');
  const canvas=createKnowledgeCanvas(db,{title:'主题证据画布',topicId:topic.id});
  const one=category=>getKnowledgeTopicDossier(db,{topicId:topic.id,category,limit:1}).items[0];
  const place=[refreshed.items.find(item=>item.objectId===liveSourceId),one('counter_evidence'),one('judgments'),one('content_history'),one('metrics'),one('reviews'),one('method_findings')];
  for(const [index,item] of place.entries())addKnowledgeCanvasNode(db,{canvasId:canvas.id,objectType:item.objectType,objectId:item.objectId,x:80+index*30,y:80+index*30});
  const canvasRead=getKnowledgeCanvas(db,canvas.id);
  if(canvasRead.nodes.length!==7||!canvasRead.nodes.find(node=>node.objectId===liveSourceId).object.body.includes('更新后摘要'))throw new Error('canvas did not retain live dossier references');
  console.log(JSON.stringify({sourceRows:2000,pageSize:100,pages:20,pagingMs}));
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
