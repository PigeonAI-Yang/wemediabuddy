import { migrateDatabase } from '../../src/main/db/migrations.ts';
import { saveAccount } from '../../src/main/accounts.ts';
import { createContentProject,saveCoreVersion,savePlatformVersion } from '../../src/main/content.ts';
import { recordKnowledgeBatch } from '../../src/main/knowledge.ts';
import { savePublicationMetricSnapshot } from '../../src/main/metrics.ts';
import { saveCurrentPlan } from '../../src/main/planning.ts';
import { createPublication } from '../../src/main/publishing.ts';
import { saveReview } from '../../src/main/reviews.ts';
import { upsertSource } from '../../src/main/sources.ts';

const db=migrateDatabase('J:/PigeonYang/WeMediaBuddyAcceptance/wmb-1302/wmb.db');
try{
  const topic=db.prepare("SELECT id,title FROM topics WHERE title='Agent Skill 生态'").get();
  const existing=db.prepare("SELECT id FROM content_projects WHERE title='WMB-1303 主题项目'").get();
  if(existing){console.log(JSON.stringify({topicId:topic.id,projectId:existing.id,replayed:true}));process.exitCode=0;}
  else{
    const counter=upsertSource(db,{originalUrl:'https://example.com/wmb-1303-counter',title:'Skill 并不能替代真实业务闭环',summary:'只有能力描述，没有业务回读时，Skill 不构成可复验交付。'});
    recordKnowledgeBatch(db,{items:[{sourceId:counter.id,topic:{title:topic.title},relation:'contradicting'}]});
    const primary=db.prepare("SELECT source_id id FROM topic_source_links WHERE topic_id=? AND relation!='contradicting' LIMIT 1").get(topic.id);
    saveCurrentPlan(db,{planDate:'2026-07-29',timezone:'Asia/Shanghai',summary:'WMB-1303 主题档案验收',items:[{topicId:topic.id,title:'Skill 生态进入发行阶段',priority:1,whyNow:'能力开始以包分发',timeliness:'本周',targetAudience:'需要稳定复用 AI 能力的创作者',angle:'从提示词转向可调用能力',pointOfView:'Skill 的价值取决于可安装、可调用和可验收',platforms:['x'],formats:['text'],titleGuidance:'先给结论',openingGuidance:'从失败案例开头',structureGuidance:'现象-反证-方法',effortEstimate:'1h',sourceIds:[primary.id,counter.id]}]});
    const project=createContentProject(db,{title:'WMB-1303 主题项目',topicId:topic.id,sourceIds:[primary.id,counter.id]});
    const core=saveCoreVersion(db,{projectId:project.id,body:'Skill 只有进入真实业务闭环，才会形成长期复利。',expectedRevision:1});
    const platform=savePlatformVersion(db,{projectId:project.id,contentVersionId:core.data.id,platform:'x',format:'text',body:'Skill 的价值不是文件数量，而是可调用与可验收。'});
    const account=saveAccount(db,{platform:'x',accountKey:'@wmb1303',displayName:'WMB 1303',loginState:'authenticated'});
    const publication=createPublication(db,{platformVersionId:platform.data.id,accountId:account.id}),now=new Date().toISOString();
    const row=db.prepare('SELECT revision FROM publications WHERE id=?').get(publication.data.id);
    db.prepare("UPDATE publications SET status='published',external_url=?,external_id='1303',published_at=?,prepared_body=?,prepared_assets_json='[]',updated_at=?,revision=? WHERE id=?")
      .run('https://x.com/wmb1303/status/1303',now,'Skill 的价值不是文件数量，而是可调用与可验收。',now,row.revision+1,publication.data.id);
    const metric=savePublicationMetricSnapshot(db,{publicationId:publication.data.id,scheduledFor:now,sourceUrl:'https://x.com/wmb1303/status/1303',capturedAt:now,normalized:{views:{status:'value',value:1303}},raw:{views:'1303'}});
    const review=saveReview(db,{publicationId:publication.data.id,metricSnapshotIds:[metric.data.id],keep:['保留真实业务证据'],stop:['停止罗列功能'],change:['先展示回读结果'],summary:'业务闭环叙事更有效',status:'final',findings:[{title:'先展示闭环结果',body:'功能必须通过真实业务链成为故事。'}]});
    console.log(JSON.stringify({topicId:topic.id,projectId:project.id,publicationId:publication.data.id,metricId:metric.data.id,reviewId:review.data.id}));
  }
}finally{db.close();}
