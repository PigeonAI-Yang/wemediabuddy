import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContentProjectWithVersion, getContentProject } from './content.ts';

const objectTables = {
  topic: ['topics', 'title', 'summary', 'revision'],
  source: ['source_items', 'title', 'summary', 'revision'],
  plan_item: ['plan_items', 'title', 'point_of_view', 'revision'],
  content_project: ['content_projects', 'title', "(SELECT body FROM content_versions WHERE project_id=content_projects.id ORDER BY version_number DESC LIMIT 1)", 'revision'],
  publication: ['publications', "platform || ' 发布'", 'external_url', 'revision'],
  metric_snapshot: ['publication_metric_snapshots', 'scheduled_for', 'normalized_json', '1'],
  review: ['reviews', "'复盘 ' || substr(id,1,8)", 'summary', 'revision'],
  method_finding: ['method_findings', 'title', 'body', 'revision']
} as const;
const relationTypes = new Set(['supports', 'contradicts', 'derived_from', 'responds_to', 'uses_method', 'becomes_content', 'custom']);

type ObjectType = keyof typeof objectTables | 'note';

function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw new Error('REVISION_CONFLICT');
}

function resolveObject(database: DatabaseSync, type: ObjectType, id: string | null) {
  if (type === 'note') return null;
  const definition = objectTables[type];
  if (!definition || !id) throw new Error('INVALID_OBJECT_REFERENCE');
  const [table, titleColumn, bodyColumn, revisionColumn] = definition;
  const row = database.prepare(`SELECT id, ${titleColumn} AS title, coalesce(${bodyColumn},'') AS body, ${revisionColumn} AS revision FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('OBJECT_NOT_FOUND');
  return row;
}

export function createKnowledgeCanvas(database: DatabaseSync, input: { title: string; topicId?: string }) {
  const title = input.title.trim();
  if (!title) throw new Error('CANVAS_TITLE_REQUIRED');
  if (input.topicId) resolveObject(database, 'topic', input.topicId);
  const id = randomUUID(), now = new Date().toISOString();
  database.prepare(`INSERT INTO knowledge_canvases(id,title,topic_id,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run(id, title, input.topicId ?? null, now, now);
  return getKnowledgeCanvas(database, id);
}

export function listKnowledgeCanvases(database: DatabaseSync) {
  return database.prepare(`SELECT c.id,c.title,c.topic_id AS topicId,c.updated_at AS updatedAt,c.revision,
    count(DISTINCT n.id) AS nodeCount,count(DISTINCT r.id) AS relationCount
    FROM knowledge_canvases c LEFT JOIN knowledge_canvas_nodes n ON n.canvas_id=c.id
    LEFT JOIN knowledge_relations r ON r.canvas_id=c.id AND r.archived_at IS NULL
    WHERE c.archived_at IS NULL GROUP BY c.id ORDER BY c.updated_at DESC,c.id`).all();
}

export function updateKnowledgeCanvas(database: DatabaseSync,input:{
  id:string;expectedRevision:number;title?:string;viewportX?:number;viewportY?:number;zoom?:number;
}){
  const current=database.prepare('SELECT revision,title,viewport_x AS viewportX,viewport_y AS viewportY,zoom FROM knowledge_canvases WHERE id=? AND archived_at IS NULL').get(input.id) as any;
  if(!current)throw new Error('CANVAS_NOT_FOUND');
  assertRevision(current.revision,input.expectedRevision);
  const title=input.title===undefined?current.title:input.title.trim();
  if(!title)throw new Error('CANVAS_TITLE_REQUIRED');
  const zoom=input.zoom??current.zoom;
  if(zoom<0.5||zoom>2)throw new Error('CANVAS_ZOOM_INVALID');
  database.prepare(`UPDATE knowledge_canvases SET title=?,viewport_x=?,viewport_y=?,zoom=?,updated_at=?,revision=revision+1 WHERE id=?`)
    .run(title,input.viewportX??current.viewportX,input.viewportY??current.viewportY,zoom,new Date().toISOString(),input.id);
  return getKnowledgeCanvas(database,input.id);
}

export function getKnowledgeCanvas(database: DatabaseSync, id: string) {
  const canvas = database.prepare(`SELECT id,title,topic_id AS topicId,viewport_x AS viewportX,viewport_y AS viewportY,zoom,revision
    FROM knowledge_canvases WHERE id=? AND archived_at IS NULL`).get(id);
  if (!canvas) throw new Error('CANVAS_NOT_FOUND');
  const nodes = (database.prepare(`SELECT id,canvas_id AS canvasId,object_type AS objectType,object_id AS objectId,note_title AS noteTitle,
    note_text AS noteText,x,y,width,height,z_index AS zIndex,revision FROM knowledge_canvas_nodes WHERE canvas_id=? ORDER BY z_index,id`).all(id) as any[])
    .map((node) => ({ ...node, object: node.objectType === 'note' ? { id: node.id, title: node.noteTitle, body: node.noteText ?? '', revision: node.revision } : resolveObject(database, node.objectType, node.objectId) }));
  const relations = database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,
    label,state,hidden,created_by AS createdBy,revision FROM knowledge_relations WHERE canvas_id=? AND archived_at IS NULL ORDER BY id`).all(id);
  const suggestions=(database.prepare(`SELECT id,kind,payload_json AS payloadJson,state,created_at AS createdAt,revision
    FROM knowledge_suggestions WHERE canvas_id=? AND state='suggested' ORDER BY created_at,id`).all(id) as any[])
    .map(({payloadJson,...item})=>({...item,payload:JSON.parse(payloadJson)}));
  return { ...canvas as object, nodes, relations, suggestions };
}

export function addKnowledgeCanvasNode(database: DatabaseSync, input: {
  canvasId: string; objectType: ObjectType; objectId?: string; noteTitle?: string; noteText?: string; x: number; y: number;
}) {
  const canvas = database.prepare('SELECT id FROM knowledge_canvases WHERE id=? AND archived_at IS NULL').get(input.canvasId);
  if (!canvas) throw new Error('CANVAS_NOT_FOUND');
  if (input.objectType === 'note') {
    if (!input.noteTitle?.trim()) throw new Error('NOTE_TITLE_REQUIRED');
  } else resolveObject(database, input.objectType, input.objectId ?? null);
  const id = randomUUID(), now = new Date().toISOString();
  database.prepare(`INSERT INTO knowledge_canvas_nodes
    (id,canvas_id,object_type,object_id,note_title,note_text,x,y,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.objectType,input.objectId ?? null,input.noteTitle?.trim() ?? null,input.noteText ?? null,input.x,input.y,now,now);
  return (getKnowledgeCanvas(database, input.canvasId) as any).nodes.find((node: any) => node.id === id);
}

export function moveKnowledgeCanvasNodes(database: DatabaseSync, input: { canvasId: string; nodes: Array<{ id: string; x: number; y: number; expectedRevision: number }> }, transaction = true) {
  const now = new Date().toISOString();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    for (const item of input.nodes) {
      const row = database.prepare('SELECT revision FROM knowledge_canvas_nodes WHERE id=? AND canvas_id=?').get(item.id,input.canvasId) as { revision: number } | undefined;
      if (!row) throw new Error('NODE_NOT_FOUND');
      assertRevision(row.revision,item.expectedRevision);
      database.prepare('UPDATE knowledge_canvas_nodes SET x=?,y=?,updated_at=?,revision=revision+1 WHERE id=?').run(item.x,item.y,now,item.id);
    }
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return getKnowledgeCanvas(database,input.canvasId);
}

export function removeKnowledgeCanvasNode(database: DatabaseSync, input: { canvasId: string; nodeId: string; expectedRevision: number }) {
  const row = database.prepare('SELECT revision FROM knowledge_canvas_nodes WHERE id=? AND canvas_id=?').get(input.nodeId,input.canvasId) as { revision: number } | undefined;
  if (!row) throw new Error('NODE_NOT_FOUND');
  assertRevision(row.revision,input.expectedRevision);
  database.prepare('DELETE FROM knowledge_canvas_nodes WHERE id=?').run(input.nodeId);
  return { id: input.nodeId, removed: true };
}

export function createKnowledgeRelation(database: DatabaseSync, input: {
  canvasId: string; fromNodeId: string; toNodeId: string; relationType: string; label?: string; createdBy?: 'user' | 'pi';
}) {
  if (!relationTypes.has(input.relationType)) throw new Error('INVALID_RELATION_TYPE');
  if (input.fromNodeId === input.toNodeId) throw new Error('RELATION_SELF_REFERENCE');
  const count = Number((database.prepare('SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (?,?)')
    .get(input.canvasId,input.fromNodeId,input.toNodeId) as { count: number }).count);
  if (count !== 2) throw new Error('RELATION_ENDPOINT_NOT_FOUND');
  const id = randomUUID(), now = new Date().toISOString(), createdBy = input.createdBy ?? 'user';
  const archived=database.prepare(`SELECT id FROM knowledge_relations
    WHERE canvas_id=? AND from_node_id=? AND to_node_id=? AND relation_type=? AND archived_at IS NOT NULL`)
    .get(input.canvasId,input.fromNodeId,input.toNodeId,input.relationType) as {id:string}|undefined;
  if(archived){
    database.prepare(`UPDATE knowledge_relations SET label=?,state=?,created_by=?,hidden=0,archived_at=NULL,updated_at=?,revision=revision+1 WHERE id=?`)
      .run(input.label?.trim()||null,createdBy==='pi'?'suggested':'confirmed',createdBy,now,archived.id);
    return database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,label,state,hidden,revision
      FROM knowledge_relations WHERE id=?`).get(archived.id);
  }
  database.prepare(`INSERT INTO knowledge_relations
    (id,canvas_id,from_node_id,to_node_id,relation_type,label,state,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.fromNodeId,input.toNodeId,input.relationType,input.label?.trim() || null,createdBy === 'pi' ? 'suggested' : 'confirmed',createdBy,now,now);
  return database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,label,state,hidden,revision
    FROM knowledge_relations WHERE id=?`).get(id);
}

export function updateKnowledgeRelation(database: DatabaseSync, input: {
  id: string; expectedRevision: number; fromNodeId?:string; toNodeId?:string; relationType?: string; label?: string; hidden?: boolean; archived?: boolean;
}) {
  if (input.relationType && !relationTypes.has(input.relationType)) throw new Error('INVALID_RELATION_TYPE');
  const current = database.prepare('SELECT revision,canvas_id AS canvasId,from_node_id AS fromNodeId,to_node_id AS toNodeId FROM knowledge_relations WHERE id=? AND archived_at IS NULL').get(input.id) as any;
  if (!current) throw new Error('RELATION_NOT_FOUND');
  assertRevision(current.revision,input.expectedRevision);
  const fromNodeId=input.fromNodeId??current.fromNodeId,toNodeId=input.toNodeId??current.toNodeId;
  if(fromNodeId===toNodeId)throw new Error('RELATION_SELF_REFERENCE');
  const endpoints=(database.prepare('SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (?,?)').get(current.canvasId,fromNodeId,toNodeId) as {count:number}).count;
  if(endpoints!==2)throw new Error('RELATION_ENDPOINT_NOT_FOUND');
  const now=new Date().toISOString();
  database.prepare(`UPDATE knowledge_relations SET from_node_id=?,to_node_id=?,relation_type=coalesce(?,relation_type),
    label=CASE WHEN ?=1 THEN ? ELSE label END,
    hidden=coalesce(?,hidden),archived_at=CASE WHEN ?=1 THEN ? ELSE archived_at END,updated_at=?,revision=revision+1 WHERE id=?`)
    .run(fromNodeId,toNodeId,input.relationType??null,input.label===undefined?0:1,input.label?.trim()||null,input.hidden===undefined?null:Number(input.hidden),input.archived?1:0,now,now,input.id);
  return input.archived ? {id:input.id,archived:true,revision:current.revision+1}
    : database.prepare(`SELECT id,from_node_id AS fromNodeId,to_node_id AS toNodeId,relation_type AS relationType,label,state,hidden,revision
      FROM knowledge_relations WHERE id=?`).get(input.id);
}

function validateKnowledgeSuggestion(database:DatabaseSync,input:{canvasId:string;kind:'node'|'relation';payload:any}){
  if(!database.prepare('SELECT id FROM knowledge_canvases WHERE id=? AND archived_at IS NULL').get(input.canvasId))throw new Error('CANVAS_NOT_FOUND');
  if(input.kind==='node'){
    const payload=input.payload;
    if(payload.objectType==='note'){if(!String(payload.noteTitle??'').trim())throw new Error('NOTE_TITLE_REQUIRED');}
    else resolveObject(database,payload.objectType,payload.objectId??null);
    const returnFromNodeIds=[...new Set(Array.isArray(payload.returnFromNodeIds)?payload.returnFromNodeIds:[])] as string[];
    if(returnFromNodeIds.length){
      if(!relationTypes.has(payload.returnRelationType))throw new Error('INVALID_RELATION_TYPE');
      const count=Number((database.prepare(`SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (${returnFromNodeIds.map(()=>'?').join(',')})`).get(input.canvasId,...returnFromNodeIds) as {count:number}).count);
      if(count!==returnFromNodeIds.length)throw new Error('RELATION_ENDPOINT_NOT_FOUND');
    }
    return {objectType:payload.objectType,objectId:payload.objectId??undefined,noteTitle:payload.noteTitle?.trim(),noteText:payload.noteText??'',x:Number(payload.x??80),y:Number(payload.y??80),
      returnFromNodeIds,returnRelationType:returnFromNodeIds.length?payload.returnRelationType:undefined};
  }
  const payload=input.payload;
  if(!relationTypes.has(payload.relationType))throw new Error('INVALID_RELATION_TYPE');
  if(payload.fromNodeId===payload.toNodeId)throw new Error('RELATION_SELF_REFERENCE');
  const count=Number((database.prepare('SELECT count(*) AS count FROM knowledge_canvas_nodes WHERE canvas_id=? AND id IN (?,?)').get(input.canvasId,payload.fromNodeId,payload.toNodeId) as {count:number}).count);
  if(count!==2)throw new Error('RELATION_ENDPOINT_NOT_FOUND');
  return {fromNodeId:payload.fromNodeId,toNodeId:payload.toNodeId,relationType:payload.relationType,label:payload.label?.trim()||undefined};
}

export function createKnowledgeSuggestion(database:DatabaseSync,input:{requestId:string;canvasId:string;kind:'node'|'relation';payload:any}){
  const payload=validateKnowledgeSuggestion(database,input),id=randomUUID(),now=new Date().toISOString();
  database.prepare(`INSERT INTO knowledge_suggestions(id,request_id,canvas_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id,input.requestId,input.canvasId,input.kind,JSON.stringify(payload),now,now);
  return {id,canvasId:input.canvasId,kind:input.kind,payload,state:'suggested',createdAt:now,revision:1};
}


export function decideKnowledgeSuggestion(database:DatabaseSync,input:{id:string;expectedRevision:number;decision:'confirm'|'reject'}){
  const row=database.prepare(`SELECT id,canvas_id AS canvasId,kind,payload_json AS payloadJson,state,revision FROM knowledge_suggestions WHERE id=?`).get(input.id) as any;
  if(!row)throw new Error('SUGGESTION_NOT_FOUND');
  assertRevision(row.revision,input.expectedRevision);
  if(row.state!=='suggested')throw new Error('SUGGESTION_ALREADY_DECIDED');
  const payload=JSON.parse(row.payloadJson),now=new Date().toISOString();
  let created=null;
  if(input.decision==='confirm'){
    if(row.kind==='node'){
      const node=addKnowledgeCanvasNode(database,{canvasId:row.canvasId,...payload});
      const relations=(payload.returnFromNodeIds??[]).map((fromNodeId:string)=>createKnowledgeRelation(database,{canvasId:row.canvasId,fromNodeId,toNodeId:node.id,relationType:payload.returnRelationType}));
      created=relations.length?{node,relations}:node;
    }else created=createKnowledgeRelation(database,{canvasId:row.canvasId,...payload});
  }
  const state=input.decision==='confirm'?'confirmed':'rejected';
  database.prepare(`UPDATE knowledge_suggestions SET state=?,decided_at=?,updated_at=?,revision=revision+1 WHERE id=?`).run(state,now,now,row.id);
  return {id:row.id,state,revision:row.revision+1,created};
}


export const KNOWLEDGE_PACKAGE_CHARACTER_LIMIT=30000;

export function previewKnowledgeContextPackage(database:DatabaseSync,input:{
  canvasId:string;nodeIds:string[];excludedNodeIds?:string[];excludedRelationIds?:string[];
}){
  const candidateIds=[...new Set(input.nodeIds)],excludedNodeIds=new Set(input.excludedNodeIds??[]),excludedRelationIds=new Set(input.excludedRelationIds??[]);
  if(!candidateIds.length)throw new Error('PACKAGE_ITEMS_REQUIRED');
  const canvas = getKnowledgeCanvas(database,input.canvasId) as any;
  const candidates=canvas.nodes.filter((node:any)=>candidateIds.includes(node.id));
  if(candidates.length!==candidateIds.length)throw new Error('PACKAGE_NODE_NOT_FOUND');
  const selected=candidates.filter((node:any)=>!excludedNodeIds.has(node.id));
  if(!selected.length)throw new Error('PACKAGE_ITEMS_REQUIRED');
  const selectedSet=new Set(selected.map((node:any)=>node.id));
  const internal=canvas.relations.filter((relation:any)=>selectedSet.has(relation.fromNodeId)&&selectedSet.has(relation.toNodeId));
  const relations=internal.filter((relation:any)=>!excludedRelationIds.has(relation.id));
  const items=selected.map((node:any,index:number)=>({nodeId:node.id,objectType:node.objectType,objectId:node.objectId??null,sortOrder:index,snapshot:node.object}));
  const excluded=[
    ...candidates.filter((node:any)=>excludedNodeIds.has(node.id)).map((node:any)=>({kind:'object',id:node.id,objectType:node.objectType,reason:'user_excluded'})),
    ...internal.filter((relation:any)=>excludedRelationIds.has(relation.id)).map((relation:any)=>({kind:'relation',id:relation.id,relationType:relation.relationType,reason:'user_excluded'}))
  ];
  const estimatedCharacters=JSON.stringify({items,relations}).length;
  return {scope:'selected_only',items,relations,excluded,truncated:false,estimatedCharacters,limitCharacters:KNOWLEDGE_PACKAGE_CHARACTER_LIMIT,overLimit:estimatedCharacters>KNOWLEDGE_PACKAGE_CHARACTER_LIMIT};
}

export function createKnowledgeContextPackage(database: DatabaseSync, input: {
  canvasId: string; name: string; objective: string; instruction?: string; nodeIds: string[];
  excludedNodeIds?:string[];excludedRelationIds?:string[];familyId?:string;
}, transaction = true) {
  if (!input.name.trim() || !input.objective.trim()) throw new Error('PACKAGE_DETAILS_REQUIRED');
  const preview=previewKnowledgeContextPackage(database,input);
  if(preview.overLimit)throw new Error('PACKAGE_TOO_LARGE');
  const id = randomUUID(), now = new Date().toISOString();
  const familyId=input.familyId??id;
  const versionNumber=input.familyId?Number((database.prepare('SELECT coalesce(max(version_number),0)+1 AS version FROM knowledge_context_packages WHERE family_id=?').get(input.familyId) as {version:number}).version):1;
  if(input.familyId&&!database.prepare('SELECT id FROM knowledge_context_packages WHERE family_id=? LIMIT 1').get(input.familyId))throw new Error('PACKAGE_FAMILY_NOT_FOUND');
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO knowledge_context_packages(id,canvas_id,name,objective,instruction,created_at,updated_at,family_id,version_number,excluded_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.name.trim(),input.objective.trim(),input.instruction?.trim() ?? '',now,now,familyId,versionNumber,JSON.stringify(preview.excluded));
    const insertItem = database.prepare(`INSERT INTO knowledge_context_package_items(package_id,node_id,object_type,object_id,sort_order,snapshot_json)
      VALUES(?,?,?,?,?,?)`);
    preview.items.forEach((item: any) => insertItem.run(id,item.nodeId,item.objectType,item.objectId,item.sortOrder,JSON.stringify(item.snapshot)));
    const insertRelation = database.prepare(`INSERT INTO knowledge_context_package_relations(package_id,relation_id,snapshot_json) VALUES(?,?,?)`);
    preview.relations.forEach((relation: any) => insertRelation.run(id,relation.id,JSON.stringify(relation)));
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  return getKnowledgeContextPackage(database,id);
}

export function createKnowledgeContextPackageIdempotent(database: DatabaseSync, input: {
  requestId:string;canvasId:string;name:string;objective:string;instruction?:string;nodeIds:string[];
  excludedNodeIds?:string[];excludedRelationIds?:string[];familyId?:string;
}) {
  const tool='knowledge.context_package_create';
  const prior=database.prepare('SELECT result_json AS resultJson FROM mcp_request_results WHERE tool=? AND request_id=?').get(tool,input.requestId) as {resultJson:string}|undefined;
  if(prior)return {...JSON.parse(prior.resultJson),replayed:true};
  database.exec('BEGIN IMMEDIATE');
  try{
    const data=createKnowledgeContextPackage(database,input,false);
    const payload={ok:true,data,error:null};
    database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run(tool,input.requestId,JSON.stringify(payload),new Date().toISOString());
    database.exec('COMMIT');
    return {...payload,replayed:false};
  }catch(error){database.exec('ROLLBACK');throw error;}
}

export function getKnowledgeContextPackage(database: DatabaseSync, id: string) {
  const info = database.prepare(`SELECT id,canvas_id AS canvasId,name,objective,instruction,scope,created_at AS createdAt,revision,
    family_id AS familyId,version_number AS versionNumber,excluded_json AS excludedJson
    FROM knowledge_context_packages WHERE id=? AND archived_at IS NULL`).get(id);
  if (!info) throw new Error('PACKAGE_NOT_FOUND');
  const items = (database.prepare(`SELECT node_id AS nodeId,object_type AS objectType,object_id AS objectId,sort_order AS sortOrder,snapshot_json AS snapshotJson
    FROM knowledge_context_package_items WHERE package_id=? ORDER BY sort_order`).all(id) as any[])
    .map(({ snapshotJson, ...item }) => ({ ...item, snapshot: JSON.parse(snapshotJson) }));
  const relations = (database.prepare('SELECT snapshot_json AS snapshotJson FROM knowledge_context_package_relations WHERE package_id=? ORDER BY relation_id').all(id) as any[])
    .map(({ snapshotJson }) => JSON.parse(snapshotJson));
  const manifest = { packageId: id, packageRevision: (info as any).revision, scope: 'selected_only', objective: (info as any).objective,
    instruction: (info as any).instruction, items, relations, excluded: JSON.parse((info as any).excludedJson), truncated: false,
    estimatedCharacters: JSON.stringify({ items, relations }).length,limitCharacters:KNOWLEDGE_PACKAGE_CHARACTER_LIMIT };
  const uses=(database.prepare(`SELECT id,request_id AS requestId,purpose,pi_session_id AS piSessionId,
    content_project_id AS contentProjectId,manifest_json AS manifestJson,created_at AS createdAt
    FROM knowledge_context_uses WHERE package_id=? ORDER BY created_at,id`).all(id) as any[])
    .map(({manifestJson,...use})=>({...use,manifest:JSON.parse(manifestJson)}));
  const projects=database.prepare(`SELECT link.project_id AS projectId,project.title,link.package_revision AS packageRevision,
    link.use_id AS useId,link.created_at AS createdAt FROM content_project_context_packages link
    JOIN content_projects project ON project.id=link.project_id WHERE link.package_id=? ORDER BY link.created_at,link.project_id`).all(id);
  const versions=database.prepare(`SELECT id,version_number AS versionNumber,created_at AS createdAt,archived_at AS archivedAt,revision
    FROM knowledge_context_packages WHERE family_id=? ORDER BY version_number DESC`).all((info as any).familyId);
  const {excludedJson,...packageInfo}=info as any;
  return { ...packageInfo, items, relations, manifest, uses, projects,versions };
}

export function listKnowledgeContextPackages(database:DatabaseSync,input:{query?:string;archived?:boolean;limit?:number;offset?:number}={}){
  const limit=Math.min(Math.max(input.limit??50,1),100),offset=Math.max(input.offset??0,0),query=input.query?.trim()??'',pattern=`%${query}%`;
  const archiveClause=input.archived?'p.archived_at IS NOT NULL':'p.archived_at IS NULL';
  const args=[query,pattern,pattern];
  const where=`${archiveClause} AND (?='' OR p.name LIKE ? OR p.objective LIKE ?)`;
  const total=Number((database.prepare(`SELECT count(*) count FROM knowledge_context_packages p WHERE ${where}`).get(...args) as {count:number}).count);
  const items=database.prepare(`SELECT p.id,p.family_id AS familyId,p.version_number AS versionNumber,p.name,p.objective,p.created_at AS createdAt,
    p.archived_at AS archivedAt,p.revision,(SELECT count(*) FROM knowledge_context_package_items i WHERE i.package_id=p.id) itemCount,
    (SELECT count(*) FROM knowledge_context_package_relations r WHERE r.package_id=p.id) relationCount,
    (SELECT count(*) FROM knowledge_context_uses u WHERE u.package_id=p.id) useCount
    FROM knowledge_context_packages p WHERE ${where} ORDER BY p.updated_at DESC,p.id LIMIT ? OFFSET ?`).all(...args,limit,offset);
  return {items,total,limit,offset,hasMore:offset+items.length<total};
}

export function archiveKnowledgeContextPackage(database:DatabaseSync,input:{id:string;expectedRevision:number}){
  const row=database.prepare('SELECT revision FROM knowledge_context_packages WHERE id=? AND archived_at IS NULL').get(input.id) as {revision:number}|undefined;
  if(!row)throw new Error('PACKAGE_NOT_FOUND');assertRevision(row.revision,input.expectedRevision);
  const now=new Date().toISOString();database.prepare('UPDATE knowledge_context_packages SET archived_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(now,now,input.id);
  return {id:input.id,archived:true,revision:row.revision+1};
}

export function recordKnowledgeContextUse(database: DatabaseSync, input: {
  requestId: string; packageId: string; expectedRevision: number; purpose: 'discussion'|'creation';
  piSessionId?: string; contentProjectId?: string;
}, transaction = true) {
  if (!input.requestId.trim()) throw new Error('REQUEST_ID_REQUIRED');
  const prior=database.prepare('SELECT id,package_id AS packageId,package_revision AS packageRevision,purpose,pi_session_id AS piSessionId,content_project_id AS contentProjectId,manifest_json AS manifestJson,created_at AS createdAt FROM knowledge_context_uses WHERE request_id=?').get(input.requestId) as any;
  if(prior)return {...prior,manifest:JSON.parse(prior.manifestJson),replayed:true};
  const pack=getKnowledgeContextPackage(database,input.packageId) as any;
  assertRevision(pack.revision,input.expectedRevision);
  if(input.contentProjectId&&!database.prepare('SELECT id FROM content_projects WHERE id=?').get(input.contentProjectId))throw new Error('CONTENT_PROJECT_NOT_FOUND');
  const id=randomUUID(),now=new Date().toISOString(),manifestJson=JSON.stringify(pack.manifest);
  if(transaction)database.exec('BEGIN IMMEDIATE');
  try{
    database.prepare(`INSERT INTO knowledge_context_uses(id,package_id,package_revision,purpose,pi_session_id,content_project_id,manifest_json,created_at,request_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id,input.packageId,pack.revision,input.purpose,input.piSessionId??null,input.contentProjectId??null,manifestJson,now,input.requestId);
    if(input.contentProjectId){
      database.prepare(`INSERT INTO content_project_context_packages(project_id,package_id,package_revision,use_id,created_at) VALUES(?,?,?,?,?)`)
        .run(input.contentProjectId,input.packageId,pack.revision,id,now);
      const linkSource=database.prepare('INSERT OR IGNORE INTO content_project_sources(project_id,source_id) VALUES(?,?)');
      pack.items.filter((item:any)=>item.objectType==='source'&&item.objectId).forEach((item:any)=>linkSource.run(input.contentProjectId!,item.objectId));
    }
    if(transaction)database.exec('COMMIT');
  }catch(error){if(transaction)database.exec('ROLLBACK');throw error;}
  return {id,requestId:input.requestId,packageId:input.packageId,packageRevision:pack.revision,purpose:input.purpose,
    piSessionId:input.piSessionId??null,contentProjectId:input.contentProjectId??null,manifest:pack.manifest,createdAt:now,replayed:false};
}

export function getContentProjectContextPackages(database: DatabaseSync, projectId: string) {
  if(!database.prepare('SELECT id FROM content_projects WHERE id=?').get(projectId))throw new Error('CONTENT_PROJECT_NOT_FOUND');
  return database.prepare(`SELECT link.package_id AS packageId,package.name,link.package_revision AS packageRevision,
    link.use_id AS useId,link.created_at AS createdAt FROM content_project_context_packages link
    JOIN knowledge_context_packages package ON package.id=link.package_id WHERE link.project_id=? ORDER BY link.created_at,link.package_id`).all(projectId);
}

function readCreativeBrief(row:any){
  if(!row)return null;
  const {structureJson,evidenceNodeIdsJson,contextNodeIdsJson,...brief}=row;
  return {...brief,structure:JSON.parse(structureJson),evidenceNodeIds:JSON.parse(evidenceNodeIdsJson),contextNodeIds:JSON.parse(contextNodeIdsJson)};
}

export function getCreativeBriefForPackage(database:DatabaseSync,packageId:string){
  return readCreativeBrief(database.prepare(`SELECT id,package_id AS packageId,package_revision AS packageRevision,title,
    core_judgment AS coreJudgment,why_now AS whyNow,structure_json AS structureJson,evidence_node_ids_json AS evidenceNodeIdsJson,
    canvas_id AS canvasId,selection_mode AS selectionMode,context_node_ids_json AS contextNodeIdsJson,
    status,created_at AS createdAt,updated_at AS updatedAt,revision FROM creative_briefs WHERE package_id=?`).get(packageId));
}

export function getCreativeBrief(database:DatabaseSync,id:string){
  return readCreativeBrief(database.prepare(`SELECT id,package_id AS packageId,package_revision AS packageRevision,title,
    core_judgment AS coreJudgment,why_now AS whyNow,structure_json AS structureJson,evidence_node_ids_json AS evidenceNodeIdsJson,
    canvas_id AS canvasId,selection_mode AS selectionMode,context_node_ids_json AS contextNodeIdsJson,
    status,created_at AS createdAt,updated_at AS updatedAt,revision FROM creative_briefs WHERE id=?`).get(id));
}

export function getCreativeBriefForContext(database:DatabaseSync,input:{canvasId:string;nodeIds:string[]}){
  const contextNodeIdsJson=JSON.stringify([...new Set(input.nodeIds)].sort());
  return readCreativeBrief(database.prepare(`SELECT id,package_id AS packageId,package_revision AS packageRevision,title,
    core_judgment AS coreJudgment,why_now AS whyNow,structure_json AS structureJson,evidence_node_ids_json AS evidenceNodeIdsJson,
    canvas_id AS canvasId,selection_mode AS selectionMode,context_node_ids_json AS contextNodeIdsJson,
    status,created_at AS createdAt,updated_at AS updatedAt,revision FROM creative_briefs
    WHERE canvas_id=? AND context_node_ids_json=? ORDER BY updated_at DESC,id LIMIT 1`).get(input.canvasId,contextNodeIdsJson));
}

function validateCreativeBriefFields(input:{title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[]},allowed:Set<string>){
  const title=input.title.trim(),coreJudgment=input.coreJudgment.trim(),whyNow=input.whyNow.trim();
  const structure=input.structure.map(item=>item.trim()).filter(Boolean);
  if(!title||!coreJudgment||!whyNow||!structure.length)throw new Error('BRIEF_FIELDS_REQUIRED');
  const evidenceNodeIds=[...new Set(input.evidenceNodeIds)];
  if(evidenceNodeIds.some(id=>!allowed.has(id)))throw new Error('BRIEF_EVIDENCE_OUTSIDE_CONTEXT');
  return {title,coreJudgment,whyNow,structure,evidenceNodeIds};
}

export function createCreativeBrief(database:DatabaseSync,input:{
  canvasId:string;nodeIds:string[];selectionMode:'current_page'|'selected';title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[];
}){
  const context=previewKnowledgeContextPackage(database,{canvasId:input.canvasId,nodeIds:input.nodeIds});
  if(context.overLimit)throw new Error('CONTEXT_TOO_LARGE');
  const contextNodeIds=context.items.map((item:any)=>item.nodeId).sort();
  const value=validateCreativeBriefFields(input,new Set(contextNodeIds)),id=randomUUID(),now=new Date().toISOString();
  database.prepare(`INSERT INTO creative_briefs(id,canvas_id,selection_mode,context_node_ids_json,title,core_judgment,why_now,structure_json,evidence_node_ids_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.canvasId,input.selectionMode,JSON.stringify(contextNodeIds),value.title,value.coreJudgment,value.whyNow,JSON.stringify(value.structure),JSON.stringify(value.evidenceNodeIds),now,now);
  return getCreativeBrief(database,id);
}


export function updateCreativeBrief(database:DatabaseSync,input:{
  id:string;expectedRevision:number;title:string;coreJudgment:string;whyNow:string;structure:string[];evidenceNodeIds:string[];status?:'draft'|'confirmed';
}){
  const current=database.prepare('SELECT context_node_ids_json AS contextNodeIdsJson,revision FROM creative_briefs WHERE id=?').get(input.id) as any;
  if(!current)throw new Error('BRIEF_NOT_FOUND');
  assertRevision(current.revision,input.expectedRevision);
  const value=validateCreativeBriefFields(input,new Set(JSON.parse(current.contextNodeIdsJson))),now=new Date().toISOString();
  database.prepare(`UPDATE creative_briefs SET title=?,core_judgment=?,why_now=?,structure_json=?,evidence_node_ids_json=?,status=?,updated_at=?,revision=revision+1 WHERE id=?`)
    .run(value.title,value.coreJudgment,value.whyNow,JSON.stringify(value.structure),JSON.stringify(value.evidenceNodeIds),input.status??'draft',now,input.id);
  return getCreativeBrief(database,input.id);
}


export function getCreativeBriefLineage(database:DatabaseSync,briefId:string){
  const brief=getCreativeBrief(database,briefId);
  if(!brief)throw new Error('BRIEF_NOT_FOUND');
  const link=database.prepare('SELECT project_id AS projectId,created_at AS createdAt FROM creative_brief_projects WHERE brief_id=?').get(briefId) as any;
  const project=link?getContentProject(database,link.projectId):null;
  const publications=link?database.prepare(`SELECT p.id,p.platform,p.status,p.external_url AS externalUrl,p.published_at AS publishedAt
    FROM publications p JOIN platform_versions pv ON pv.id=p.platform_version_id WHERE pv.project_id=? ORDER BY p.created_at,p.id`).all(link.projectId):[];
  const publicationIds=(publications as any[]).map(item=>item.id);
  const metrics=publicationIds.length?database.prepare(`SELECT id,publication_id AS publicationId,captured_at AS capturedAt,normalized_json AS normalizedJson
    FROM publication_metric_snapshots WHERE publication_id IN (${publicationIds.map(()=>'?').join(',')}) ORDER BY captured_at,id`).all(...publicationIds).map((row:any)=>({...row,normalized:JSON.parse(row.normalizedJson)})):[];
  const reviews=publicationIds.length?database.prepare(`SELECT id,publication_id AS publicationId,status,summary,revision FROM reviews
    WHERE publication_id IN (${publicationIds.map(()=>'?').join(',')}) ORDER BY created_at,id`).all(...publicationIds):[];
  const reviewIds=(reviews as any[]).map(item=>item.id);
  const findings=reviewIds.length?database.prepare(`SELECT id,review_id AS reviewId,title,body,revision FROM method_findings
    WHERE review_id IN (${reviewIds.map(()=>'?').join(',')}) ORDER BY created_at,id`).all(...reviewIds):[];
  return {brief,link:link??null,project,publications,metrics,reviews,findings};
}

export function createContentProjectFromBrief(database:DatabaseSync,input:{briefId:string;expectedRevision:number}){
  const brief=getCreativeBrief(database,input.briefId);
  if(!brief)throw new Error('BRIEF_NOT_FOUND');
  assertRevision(brief.revision,input.expectedRevision);
  if(brief.status!=='confirmed')throw new Error('BRIEF_NOT_CONFIRMED');
  const existing=database.prepare('SELECT project_id AS projectId FROM creative_brief_projects WHERE brief_id=?').get(input.briefId) as {projectId:string}|undefined;
  if(existing)return getCreativeBriefLineage(database,input.briefId);
  const nodeIds=brief.contextNodeIds as string[],placeholders=nodeIds.map(()=>'?').join(',');
  const refs=nodeIds.length?database.prepare(`SELECT object_type AS objectType,object_id AS objectId FROM knowledge_canvas_nodes WHERE id IN (${placeholders})`).all(...nodeIds) as any[]:[];
  const sourceIds=refs.filter(item=>item.objectType==='source'&&item.objectId).map(item=>item.objectId);
  const topicId=refs.find(item=>item.objectType==='topic'&&item.objectId)?.objectId;
  const body=`# ${brief.title}\n\n${brief.coreJudgment}\n\n## 为什么现在\n\n${brief.whyNow}\n\n## 内容结构\n\n${brief.structure.map((item:string,index:number)=>`${index+1}. ${item}`).join('\n')}`;
  const now=new Date().toISOString();
  const project=createContentProjectWithVersion(database,{title:brief.title,body,sourceIds,topicId},false);
  database.prepare('INSERT INTO creative_brief_projects(brief_id,project_id,created_at) VALUES(?,?,?)').run(brief.id,project.id,now);
  return getCreativeBriefLineage(database,brief.id);
}
