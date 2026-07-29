import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type VerificationStatus = 'pending' | 'verified' | 'disputed' | 'rejected';
export type ManagementStatus = 'active' | 'watching' | 'expired' | 'archived';
export type TopicStatus = 'active' | 'watching' | 'dormant' | 'archived';
export type DomainStatus = 'active' | 'watching' | 'dormant';
export type TopicRelation = 'primary' | 'supporting' | 'background' | 'contradicting';

const verification = new Set<VerificationStatus>(['pending', 'verified', 'disputed', 'rejected']);
const management = new Set<ManagementStatus>(['active', 'watching', 'expired', 'archived']);
const topicStatuses = new Set<TopicStatus>(['active', 'watching', 'dormant', 'archived']);
const domainStatuses = new Set<DomainStatus>(['active','watching','dormant']);

export function listKnowledgeSources(database: DatabaseSync, input: {
  query?: string; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus; limit?: number; offset?: number;
} = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const query = input.query?.trim() ?? '';
  const where: string[] = ["(? = '' OR s.title LIKE ? OR coalesce(s.summary, '') LIKE ? OR s.keywords_json LIKE ?)"];
  const pattern = `%${query}%`;
  const args: Array<string | number | null> = [query, pattern, pattern, pattern];
  if (input.verificationStatus) { where.push('s.verification_status = ?'); args.push(input.verificationStatus); }
  if (input.managementStatus) { where.push('s.management_status = ?'); args.push(input.managementStatus); }
  const clause = where.join(' AND ');
  const total = Number((database.prepare(`SELECT count(*) AS count FROM source_items s WHERE ${clause}`).get(...args) as { count: number }).count);
  const items = database.prepare(`
    SELECT s.id, s.title, s.original_url AS originalUrl, s.author, s.published_at AS publishedAt,
      s.collected_at AS collectedAt, s.summary, s.priority, s.verification_status AS verificationStatus,
      s.management_status AS managementStatus, s.revision,
      coalesce((SELECT group_concat(t.title, '、') FROM topic_source_links l JOIN topics t ON t.id=l.topic_id WHERE l.source_id=s.id), '') AS topics,
      (SELECT count(*) FROM plan_items pi, json_each(pi.source_ids_json) j WHERE j.value=s.id) AS opportunityCount,
      (SELECT count(*) FROM content_project_sources cps WHERE cps.source_id=s.id) AS projectCount,
      (SELECT count(*) FROM content_project_sources cps JOIN content_projects cp ON cp.id=cps.project_id
        JOIN content_versions cv ON cv.project_id=cp.id JOIN platform_versions pv ON pv.content_version_id=cv.id
        JOIN publications p ON p.platform_version_id=pv.id WHERE cps.source_id=s.id AND p.status='published') AS publicationCount
    FROM source_items s WHERE ${clause}
    ORDER BY s.collected_at DESC, s.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function updateKnowledgeSource(database: DatabaseSync, input: {
  id: string; expectedRevision: number; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus;
}) {
  if (input.verificationStatus && !verification.has(input.verificationStatus)) throw new Error('INVALID_VERIFICATION_STATUS');
  if (input.managementStatus && !management.has(input.managementStatus)) throw new Error('INVALID_MANAGEMENT_STATUS');
  const current = database.prepare('SELECT revision FROM source_items WHERE id=?').get(input.id) as { revision: number } | undefined;
  if (!current) throw new Error('SOURCE_NOT_FOUND');
  if (current.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
  const next = current.revision + 1;
  database.prepare(`UPDATE source_items SET verification_status=coalesce(?, verification_status),
    management_status=coalesce(?, management_status), updated_at=?, revision=? WHERE id=?`)
    .run(input.verificationStatus ?? null, input.managementStatus ?? null, new Date().toISOString(), next, input.id);
  return { id: input.id, revision: next };
}

export function upsertKnowledgeTopic(database: DatabaseSync, input: {
  canonicalKey?: string; title: string; kind?: 'theme' | 'event'; summary?: string; status?: TopicStatus;
}) {
  const key = normalizeTopicKey(input.canonicalKey ?? input.title);
  if (!key || !input.title.trim()) throw new Error('TOPIC_REQUIRED');
  if (input.status && !topicStatuses.has(input.status)) throw new Error('INVALID_TOPIC_STATUS');
  const now = new Date().toISOString();
  const existing = database.prepare('SELECT id, revision FROM topics WHERE canonical_key=?').get(key) as { id: string; revision: number } | undefined;
  if (existing) {
    database.prepare(`UPDATE topics SET title=?, kind=?, summary=coalesce(?, summary), status=coalesce(?, status),
      last_seen_at=?, updated_at=?, revision=revision+1 WHERE id=?`)
      .run(input.title.trim(), input.kind ?? 'theme', input.summary ?? null, input.status ?? null, now, now, existing.id);
    return { id: existing.id, created: false, revision: existing.revision + 1 };
  }
  const id = randomUUID();
  database.prepare(`INSERT INTO topics
    (id,title,created_at,updated_at,revision,canonical_key,kind,summary,status,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,1,?,?,?,?,?,?)`)
    .run(id, input.title.trim(), now, now, key, input.kind ?? 'theme', input.summary ?? null, input.status ?? 'active', now, now);
  return { id, created: true, revision: 1 };
}

export function recordKnowledgeBatch(database: DatabaseSync, input: { items: Array<{
  sourceId: string; topic: { canonicalKey?: string; title: string; kind?: 'theme' | 'event'; summary?: string };
  relation?: TopicRelation; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus;
}> }) {
  if (!input.items.length) throw new Error('KNOWLEDGE_ITEMS_REQUIRED');
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const results = input.items.map((item) => {
      const source = database.prepare('SELECT revision FROM source_items WHERE id=?').get(item.sourceId) as { revision: number } | undefined;
      if (!source) throw new Error('SOURCE_NOT_FOUND');
      const topic = upsertKnowledgeTopic(database, item.topic);
      database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
        .run(topic.id, item.sourceId, item.relation ?? 'primary', now, now);
      if (item.verificationStatus || item.managementStatus) {
        updateKnowledgeSource(database, { id: item.sourceId, expectedRevision: source.revision,
          verificationStatus: item.verificationStatus, managementStatus: item.managementStatus });
      }
      return { sourceId: item.sourceId, topicId: topic.id };
    });
    database.exec('COMMIT');
    return results;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function listKnowledgeTopics(database: DatabaseSync, input: { query?: string; status?: TopicStatus; limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100), offset = Math.max(input.offset ?? 0, 0);
  const query = input.query?.trim() ?? '', pattern = `%${query}%`;
  const rows = database.prepare(`SELECT t.id,t.title,t.canonical_key AS canonicalKey,t.kind,t.summary,t.status,
    t.first_seen_at AS firstSeenAt,t.last_seen_at AS lastSeenAt,t.revision,count(DISTINCT l.source_id) AS sourceCount,
    count(DISTINCT pi.id) AS opportunityCount
    FROM topics t LEFT JOIN topic_source_links l ON l.topic_id=t.id LEFT JOIN plan_items pi ON pi.topic_id=t.id
    WHERE (?='' OR t.title LIKE ? OR coalesce(t.summary,'') LIKE ?) AND (?='' OR t.status=?)
    GROUP BY t.id ORDER BY t.last_seen_at DESC,t.id DESC LIMIT ? OFFSET ?`)
    .all(query, pattern, pattern, input.status ?? '', input.status ?? '', limit, offset);
  return rows;
}

export function createKnowledgeDomain(database:DatabaseSync,input:{
  title:string;description?:string;status?:DomainStatus;topicIds?:string[];
},transaction=true){
  const title=input.title.trim(),status=input.status??'active',topicIds=[...new Set(input.topicIds??[])];
  if(!title)throw new Error('DOMAIN_TITLE_REQUIRED');
  if(!domainStatuses.has(status))throw new Error('INVALID_DOMAIN_STATUS');
  const id=randomUUID(),now=new Date().toISOString();
  if(transaction)database.exec('BEGIN IMMEDIATE');
  try{
    for(const topicId of topicIds)if(!database.prepare('SELECT id FROM topics WHERE id=? AND status!=?').get(topicId,'archived'))throw new Error('TOPIC_NOT_FOUND');
    database.prepare(`INSERT INTO knowledge_domains(id,title,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(id,title,input.description?.trim()??'',status,now,now);
    const insert=database.prepare('INSERT INTO knowledge_domain_topics(domain_id,topic_id,sort_order,added_at) VALUES(?,?,?,?)');
    topicIds.forEach((topicId,index)=>insert.run(id,topicId,index,now));
    if(transaction)database.exec('COMMIT');
  }catch(error){if(transaction)database.exec('ROLLBACK');throw error;}
  return getKnowledgeDomain(database,id);
}

export function updateKnowledgeDomain(database:DatabaseSync,input:{
  id:string;expectedRevision:number;title?:string;description?:string;status?:DomainStatus;topicIds?:string[];archived?:boolean;
},transaction=true){
  const current=database.prepare('SELECT title,description,status,revision FROM knowledge_domains WHERE id=? AND archived_at IS NULL').get(input.id) as any;
  if(!current)throw new Error('DOMAIN_NOT_FOUND');
  if(current.revision!==input.expectedRevision)throw new Error('REVISION_CONFLICT');
  const title=input.title===undefined?current.title:input.title.trim(),status=input.status??current.status,now=new Date().toISOString();
  if(!title)throw new Error('DOMAIN_TITLE_REQUIRED');
  if(!domainStatuses.has(status))throw new Error('INVALID_DOMAIN_STATUS');
  const topicIds=input.topicIds&&[...new Set(input.topicIds)];
  if(transaction)database.exec('BEGIN IMMEDIATE');
  try{
    for(const topicId of topicIds??[])if(!database.prepare('SELECT id FROM topics WHERE id=? AND status!=?').get(topicId,'archived'))throw new Error('TOPIC_NOT_FOUND');
    database.prepare(`UPDATE knowledge_domains SET title=?,description=?,status=?,archived_at=CASE WHEN ?=1 THEN ? ELSE archived_at END,
      updated_at=?,revision=revision+1 WHERE id=?`).run(title,input.description===undefined?current.description:input.description.trim(),status,input.archived?1:0,now,now,input.id);
    if(topicIds){
      database.prepare('DELETE FROM knowledge_domain_topics WHERE domain_id=?').run(input.id);
      const insert=database.prepare('INSERT INTO knowledge_domain_topics(domain_id,topic_id,sort_order,added_at) VALUES(?,?,?,?)');
      topicIds.forEach((topicId,index)=>insert.run(input.id,topicId,index,now));
    }
    if(transaction)database.exec('COMMIT');
  }catch(error){if(transaction)database.exec('ROLLBACK');throw error;}
  return input.archived?{id:input.id,archived:true,revision:current.revision+1}:getKnowledgeDomain(database,input.id);
}

export function listKnowledgeDomains(database:DatabaseSync,input:{
  query?:string;status?:DomainStatus;order?:'manual'|'recent'|'size';limit?:number;offset?:number;
}={}){
  const limit=Math.min(Math.max(input.limit??50,1),100),offset=Math.max(input.offset??0,0),query=input.query?.trim()??'',pattern=`%${query}%`;
  if(input.status&&!domainStatuses.has(input.status))throw new Error('INVALID_DOMAIN_STATUS');
  const order=input.order==='size'?'topicCount DESC,sourceCount DESC,d.id':input.order==='recent'?'lastChangedAt DESC,d.id':'d.sort_order,d.updated_at DESC,d.id';
  const base=`FROM knowledge_domains d LEFT JOIN knowledge_domain_topics dt ON dt.domain_id=d.id LEFT JOIN topics t ON t.id=dt.topic_id
    LEFT JOIN topic_source_links tsl ON tsl.topic_id=t.id LEFT JOIN source_items s ON s.id=tsl.source_id
    WHERE d.archived_at IS NULL AND (?='' OR d.title LIKE ? OR d.description LIKE ? OR EXISTS(
      SELECT 1 FROM knowledge_domain_topics match_dt JOIN topics match_t ON match_t.id=match_dt.topic_id
      WHERE match_dt.domain_id=d.id AND match_t.title LIKE ?
    )) AND (?='' OR d.status=?)`;
  const total=Number((database.prepare(`SELECT count(DISTINCT d.id) AS count ${base}`).get(query,pattern,pattern,pattern,input.status??'',input.status??'') as {count:number}).count);
  const items=database.prepare(`SELECT d.id,d.title,d.description,d.status,d.sort_order AS sortOrder,d.revision,d.created_at AS createdAt,d.updated_at AS updatedAt,
    count(DISTINCT t.id) AS topicCount,count(DISTINCT s.id) AS sourceCount,
    count(DISTINCT CASE WHEN s.collected_at>=datetime('now','-7 days') THEN s.id END) AS recentSourceCount,
    coalesce(max(s.collected_at),max(t.last_seen_at),d.updated_at) AS lastChangedAt ${base}
    GROUP BY d.id ORDER BY ${order} LIMIT ? OFFSET ?`).all(query,pattern,pattern,pattern,input.status??'',input.status??'',limit,offset);
  return {items,total,limit,offset,hasMore:offset+items.length<total};
}

export function getKnowledgeDomain(database:DatabaseSync,id:string,input:{limit?:number;offset?:number}={}){
  const domain=(listKnowledgeDomains(database,{limit:100}).items as any[]).find(item=>item.id===id);
  if(!domain)throw new Error('DOMAIN_NOT_FOUND');
  const limit=Math.min(Math.max(input.limit??50,1),100),offset=Math.max(input.offset??0,0);
  const total=Number((database.prepare('SELECT count(*) AS count FROM knowledge_domain_topics WHERE domain_id=?').get(id) as {count:number}).count);
  const topics=database.prepare(`SELECT t.id,t.title,t.summary,t.status,t.first_seen_at AS firstSeenAt,t.last_seen_at AS lastSeenAt,t.revision,
    count(DISTINCT tsl.source_id) AS sourceCount,count(DISTINCT pi.id) AS opportunityCount,dt.sort_order AS sortOrder
    FROM knowledge_domain_topics dt JOIN topics t ON t.id=dt.topic_id LEFT JOIN topic_source_links tsl ON tsl.topic_id=t.id
    LEFT JOIN plan_items pi ON pi.topic_id=t.id WHERE dt.domain_id=? GROUP BY t.id ORDER BY dt.sort_order,t.last_seen_at DESC,t.id LIMIT ? OFFSET ?`)
    .all(id,limit,offset);
  return {...domain,topics,total,limit,offset,hasMore:offset+topics.length<total};
}

export function getKnowledgeContext(database: DatabaseSync, input: { topicId?: string; sourceId?: string; query?: string; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const topicIds = input.topicId ? [input.topicId] : input.sourceId
    ? (database.prepare('SELECT topic_id AS id FROM topic_source_links WHERE source_id=?').all(input.sourceId) as Array<{ id: string }>).map((r) => r.id)
    : (database.prepare("SELECT id FROM topics WHERE title LIKE ? ORDER BY last_seen_at DESC LIMIT ?").all(`%${input.query ?? ''}%`, limit) as Array<{ id: string }>).map((r) => r.id);
  const sourceIds = input.sourceId ? [input.sourceId] : topicIds.length
    ? (database.prepare(`SELECT DISTINCT source_id AS id FROM topic_source_links WHERE topic_id IN (${topicIds.map(() => '?').join(',')}) LIMIT ?`).all(...topicIds, limit) as Array<{ id: string }>).map((r) => r.id) : [];
  const topics = topicIds.length ? database.prepare(`SELECT id,title,kind,summary,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt FROM topics WHERE id IN (${topicIds.map(() => '?').join(',')})`).all(...topicIds) : [];
  const sources = sourceIds.length ? database.prepare(`SELECT id,title,original_url AS originalUrl,summary,priority,verification_status AS verificationStatus,management_status AS managementStatus,collected_at AS collectedAt FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds) : [];
  const opportunities = sourceIds.length ? database.prepare(`SELECT DISTINCT pi.id,pi.title,pi.priority,p.plan_date AS planDate
    FROM plan_items pi JOIN plans p ON p.id=pi.plan_id, json_each(pi.source_ids_json) j WHERE j.value IN (${sourceIds.map(() => '?').join(',')})
    ORDER BY p.plan_date DESC,pi.priority LIMIT ?`).all(...sourceIds, limit) : [];
  const projects = sourceIds.length ? database.prepare(`SELECT DISTINCT cp.id,cp.title,cp.status,cp.updated_at AS updatedAt
    FROM content_project_sources cps JOIN content_projects cp ON cp.id=cps.project_id WHERE cps.source_id IN (${sourceIds.map(() => '?').join(',')})
    ORDER BY cp.updated_at DESC LIMIT ?`).all(...sourceIds, limit) : [];
  const projectIds = (projects as Array<{ id: string }>).map((p) => p.id);
  const publications = projectIds.length ? database.prepare(`SELECT DISTINCT p.id,p.platform,p.status,p.external_url AS externalUrl,p.published_at AS publishedAt
    FROM content_versions cv JOIN platform_versions pv ON pv.content_version_id=cv.id JOIN publications p ON p.platform_version_id=pv.id
    WHERE cv.project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY p.updated_at DESC LIMIT ?`).all(...projectIds, limit) : [];
  const publicationIds = (publications as Array<{ id: string }>).map((p) => p.id);
  const metrics = publicationIds.length ? database.prepare(`SELECT id,publication_id AS publicationId,scheduled_for AS scheduledFor,captured_at AS capturedAt,
    source_url AS sourceUrl,normalized_json AS normalizedJson FROM publication_metric_snapshots
    WHERE publication_id IN (${publicationIds.map(() => '?').join(',')}) ORDER BY captured_at DESC LIMIT ?`).all(...publicationIds, limit) : [];
  const reviews = publicationIds.length ? database.prepare(`SELECT id,publication_id AS publicationId,status,summary,keep_json AS keepJson,stop_json AS stopJson,change_json AS changeJson,finalized_at AS finalizedAt
    FROM reviews WHERE publication_id IN (${publicationIds.map(() => '?').join(',')}) AND status='final' ORDER BY finalized_at DESC LIMIT ?`).all(...publicationIds, limit) : [];
  const reviewIds = (reviews as Array<{ id: string }>).map((r) => r.id);
  const findings = reviewIds.length ? database.prepare(`SELECT id,review_id AS reviewId,title,body,updated_at AS updatedAt FROM method_findings
    WHERE review_id IN (${reviewIds.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`).all(...reviewIds, limit) : [];
  return { topics, sources, opportunities, projects, publications, metrics, reviews, findings };
}

export const topicDossierCategories = ['sources','judgments','audience_demands','counter_evidence','content_history','metrics','reviews','method_findings'] as const;
export type TopicDossierCategory = typeof topicDossierCategories[number];

export function getKnowledgeTopicDossier(database: DatabaseSync,input:{
  topicId:string;category?:TopicDossierCategory;limit?:number;offset?:number;
}){
  const topic=database.prepare(`SELECT id,title,kind,summary,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,revision
    FROM topics WHERE id=? AND status!='archived'`).get(input.topicId);
  if(!topic)throw new Error('TOPIC_NOT_FOUND');
  const limit=Math.min(Math.max(input.limit??50,1),100),offset=Math.max(input.offset??0,0);
  const projectScope=`(cp.topic_id=? OR EXISTS(
    SELECT 1 FROM content_project_sources cps JOIN topic_source_links linked ON linked.source_id=cps.source_id
    WHERE cps.project_id=cp.id AND linked.topic_id=?
  ))`;
  const branches=[
    `SELECT CASE WHEN max(tsl.relation='contradicting')=1 THEN 'counter_evidence' ELSE 'sources' END category,
      s.id objectId,'source' objectType,s.title,coalesce(s.summary,'') body,s.collected_at occurredAt,
      json_object('relation',CASE WHEN max(tsl.relation='contradicting')=1 THEN 'contradicting' ELSE min(tsl.relation) END,'verificationStatus',s.verification_status,'managementStatus',s.management_status) metadataJson
      FROM topic_source_links tsl JOIN source_items s ON s.id=tsl.source_id WHERE tsl.topic_id=? GROUP BY s.id`,
    `SELECT 'judgments',pi.id,'plan_item',pi.title,pi.point_of_view,p.plan_date,
      json_object('whyNow',pi.why_now,'timeliness',pi.timeliness) FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE pi.topic_id=?`,
    `SELECT 'audience_demands',pi.id,'plan_item',pi.title,pi.target_audience,p.plan_date,
      json_object('angle',pi.angle,'formats',pi.formats_json) FROM plan_items pi JOIN plans p ON p.id=pi.plan_id WHERE pi.topic_id=?`,
    `SELECT 'content_history',cp.id,'content_project',cp.title,coalesce((SELECT body FROM content_versions WHERE project_id=cp.id ORDER BY version_number DESC LIMIT 1),''),cp.updated_at,
      json_object('status',cp.status,'archived',cp.archived_at IS NOT NULL) FROM content_projects cp WHERE ${projectScope}`,
    `SELECT DISTINCT 'metrics',m.id,'metric_snapshot',p.platform || ' 指标',m.normalized_json,m.captured_at,
      json_object('publicationId',p.id,'sourceUrl',m.source_url) FROM content_projects cp
      JOIN content_versions cv ON cv.project_id=cp.id JOIN platform_versions pv ON pv.content_version_id=cv.id
      JOIN publications p ON p.platform_version_id=pv.id JOIN publication_metric_snapshots m ON m.publication_id=p.id WHERE ${projectScope}`,
    `SELECT DISTINCT 'reviews',r.id,'review','复盘：' || coalesce(r.summary,substr(r.id,1,8)),coalesce(r.summary,''),coalesce(r.finalized_at,r.updated_at),
      json_object('publicationId',r.publication_id,'keep',r.keep_json,'stop',r.stop_json,'change',r.change_json) FROM content_projects cp
      JOIN content_versions cv ON cv.project_id=cp.id JOIN platform_versions pv ON pv.content_version_id=cv.id
      JOIN publications p ON p.platform_version_id=pv.id JOIN reviews r ON r.publication_id=p.id WHERE r.status='final' AND ${projectScope}`,
    `SELECT DISTINCT 'method_findings',f.id,'method_finding',f.title,f.body,f.updated_at,
      json_object('reviewId',f.review_id) FROM content_projects cp
      JOIN content_versions cv ON cv.project_id=cp.id JOIN platform_versions pv ON pv.content_version_id=cv.id
      JOIN publications p ON p.platform_version_id=pv.id JOIN reviews r ON r.publication_id=p.id
      JOIN method_findings f ON f.review_id=r.id WHERE r.status='final' AND ${projectScope}`
  ];
  const union=branches.join(' UNION ALL ');
  const topicParams=Array(11).fill(input.topicId);
  const counts=Object.fromEntries(topicDossierCategories.map(category=>[category,0])) as Record<TopicDossierCategory,number>;
  for(const row of database.prepare(`SELECT category,count(*) count FROM (${union}) GROUP BY category`).all(...topicParams) as Array<{category:TopicDossierCategory;count:number}>)counts[row.category]=Number(row.count);
  const category=input.category??'',items=(database.prepare(`SELECT * FROM (${union}) WHERE (?='' OR category=?) ORDER BY occurredAt DESC,category,objectId LIMIT ? OFFSET ?`)
    .all(...topicParams,category,category,limit,offset) as Array<Record<string,unknown>>).map(item=>({...item,metadata:JSON.parse(String(item.metadataJson)),metadataJson:undefined}));
  const total=category?counts[category as TopicDossierCategory]:Object.values(counts).reduce((sum,count)=>sum+count,0);
  return {topic,counts,items,total,limit,offset,hasMore:offset+items.length<total};
}

export function listRediscovery(database: DatabaseSync) {
  const unused = database.prepare(`SELECT s.id,s.title,s.priority,s.collected_at AS collectedAt,'高价值但尚未创作' AS reason FROM source_items s
    WHERE s.management_status!='archived' AND s.priority<=2 AND NOT EXISTS(SELECT 1 FROM content_project_sources c WHERE c.source_id=s.id)
    ORDER BY s.priority,s.collected_at DESC LIMIT 20`).all();
  const watching = database.prepare(`SELECT id,title,priority,collected_at AS collectedAt,'持续观察' AS reason FROM source_items
    WHERE management_status='watching' ORDER BY collected_at DESC LIMIT 20`).all();
  const pending = database.prepare(`SELECT id,title,priority,collected_at AS collectedAt,'待核验超过 7 天' AS reason FROM source_items
    WHERE verification_status='pending' AND collected_at < datetime('now','-7 days') ORDER BY collected_at DESC LIMIT 20`).all();
  return { unused, watching, pending };
}

function normalizeTopicKey(value: string) { return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }
