import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { createKnowledgeDomain,getKnowledgeDomain,listKnowledgeDomains,updateKnowledgeDomain,upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { upsertSource } from '../src/main/sources.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'wmb-domain-'));
let db;
try{
  db=migrateDatabase(path.join(directory,'wmb.db'));
  const source=upsertSource(db,{originalUrl:'https://example.com/domain-source',title:'真实领域资料',summary:'领域变化证据'});
  const topics=[];
  for(let index=0;index<125;index++)topics.push(upsertKnowledgeTopic(db,{title:`长期主题 ${String(index).padStart(3,'0')}`}));
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(topics[0].id,source.id,'primary',new Date().toISOString(),new Date().toISOString());
  const domain=createKnowledgeDomain(db,{title:'Agent 与工作流',description:'真实工作与能力组织',topicIds:topics.map(item=>item.id)});
  const first=getKnowledgeDomain(db,domain.id,{limit:100});
  const second=getKnowledgeDomain(db,domain.id,{limit:100,offset:100});
  if(first.total!==125||first.topics.length!==100||!first.hasMore||second.topics.length!==25||second.hasMore)throw new Error('domain topic paging omitted items');
  const listed=listKnowledgeDomains(db,{query:'长期主题 124',order:'size'});
  if(listed.total!==1||listed.items[0].topicCount!==125||listed.items[0].sourceCount!==1)throw new Error('domain counts/search mismatch');
  const updated=updateKnowledgeDomain(db,{id:domain.id,expectedRevision:domain.revision,title:'Agent 工作流',status:'watching'});
  let stale=false;try{updateKnowledgeDomain(db,{id:domain.id,expectedRevision:domain.revision,title:'覆盖'});}catch(error){stale=String(error).includes('REVISION_CONFLICT');}
  if(!stale||updated.title!=='Agent 工作流'||updated.status!=='watching')throw new Error('domain revision/status mismatch');
  const archived=updateKnowledgeDomain(db,{id:domain.id,expectedRevision:updated.revision,archived:true});
  if(!archived.archived||listKnowledgeDomains(db).total!==0)throw new Error('domain archive remained active');
}finally{db?.close();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
