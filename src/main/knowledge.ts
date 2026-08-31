import { broadcastDataChanged } from './data-changed.ts';
import { listUpdateReceipts } from './knowledge-flywheel.ts';
// WMB-5237：Source 删除生命周期清正文 revision 历史（不可变表经授权 purge 窗口删除，避免 FK cascade 触发 DELETE 守卫）。
import { purgeSourceBodyHistory } from './source-body-cache.ts';
// WMB-5247：删除门 —— 删除 Source 前读取其 Asset 被知识 Evidence/内容/平台 Binding/发布快照等引用的清单；有引用则阻止普通删除并要求显式确认（素材字节永不随删除消失）。
import { sourceDeleteGate } from './media-governance.ts';
import { CommandDispatchError } from './command-dispatcher.ts';
// WMB-5238：Source/Topic 写路径增量索引与日志投影。
import { projectSourceSaved, projectTopicSaved } from './wiki-index-triggers.ts';
// WMB-5233：主题列表诚实三态（uncompiled / legacy_shell / compiled）。
import { listTopicCompileStates } from './knowledge-compile-state.ts';
import { enqueueKnowledgeCompileJob, enqueueKnowledgeRouteJob, wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';
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
  query?: string; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus; includeArchived?: boolean; limit?: number; offset?: number;
} = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const query = input.query?.trim() ?? '';
  const where: string[] = ["(? = '' OR s.title LIKE ? OR coalesce(s.summary, '') LIKE ? OR s.keywords_json LIKE ?)"];
  const pattern = `%${query}%`;
  const args: Array<string | number | null> = [query, pattern, pattern, pattern];
  if (input.verificationStatus) { where.push('s.verification_status = ?'); args.push(input.verificationStatus); }
  if (input.managementStatus) {
    where.push('s.management_status = ?');
    args.push(input.managementStatus);
  } else if (!input.includeArchived) {
    where.push("s.management_status != 'archived'");
  }
  const clause = where.join(' AND ');
  const total = Number((database.prepare(`SELECT count(*) AS count FROM source_items s WHERE ${clause}`).get(...args) as { count: number }).count);
  const rows = database.prepare(`
    SELECT s.id, s.title, s.original_url AS originalUrl, s.author, s.published_at AS publishedAt,
      s.collected_at AS collectedAt, s.summary, s.priority, s.verification_status AS verificationStatus,
      s.management_status AS managementStatus, s.revision,
      (SELECT json_object('decision', j.decision, 'reasonCode', j.reason_code, 'reason', j.reason,
        'judgedBy', j.judged_by, 'judgedAt', j.judged_at)
        FROM source_lane_judgments j WHERE j.source_id = s.id
        ORDER BY j.judged_at DESC, j.id DESC LIMIT 1) AS laneJudgmentJson,
      coalesce((SELECT group_concat(t.title, '、') FROM topic_source_links l JOIN topics t ON t.id=l.topic_id WHERE l.source_id=s.id), '') AS topics,
      (SELECT count(*) FROM plan_items pi, json_each(pi.source_ids_json) j WHERE j.value=s.id) AS opportunityCount,
      (SELECT count(*) FROM content_project_sources cps WHERE cps.source_id=s.id) AS projectCount,
      (SELECT count(*) FROM content_project_sources cps JOIN content_projects cp ON cp.id=cps.project_id
        JOIN content_versions cv ON cv.project_id=cp.id JOIN platform_versions pv ON pv.content_version_id=cv.id
        JOIN publications p ON p.platform_version_id=pv.id WHERE cps.source_id=s.id AND p.status='published') AS publicationCount
    FROM source_items s WHERE ${clause}
    ORDER BY s.collected_at DESC, s.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  // 「已移出」视图徽标数据源：source_lane_judgments 最新一行（追加型语义，按 judged_at DESC 取首行）；
  // 无判定行 = 主编手动归档（徽标显示「主编归档」），有判定行 = AI/系统判定原因可展示。
  const items = rows.map((item) => {
    const { laneJudgmentJson, ...rest } = item as { laneJudgmentJson: string | null } & Record<string, unknown>;
    return { ...rest, laneJudgment: laneJudgmentJson ? JSON.parse(laneJudgmentJson) : null };
  });
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

export function updateKnowledgeSource(database: DatabaseSync, input: {
  id: string;
  expectedRevision: number;
  verificationStatus?: VerificationStatus;
  managementStatus?: ManagementStatus;
  title?: string;
  summary?: string | null;
  author?: string | null;
}, broadcast = true) {
  if (input.verificationStatus && !verification.has(input.verificationStatus)) throw new Error('INVALID_VERIFICATION_STATUS');
  if (input.managementStatus && !management.has(input.managementStatus)) throw new Error('INVALID_MANAGEMENT_STATUS');
  const title = input.title?.trim();
  if (input.title !== undefined && !title) throw new Error('TITLE_REQUIRED');
  const current = database.prepare('SELECT revision FROM source_items WHERE id=?').get(input.id) as { revision: number } | undefined;
  if (!current) throw new Error('SOURCE_NOT_FOUND');
  if (current.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
  const next = current.revision + 1;
  database.prepare(`UPDATE source_items SET
    verification_status=coalesce(?, verification_status),
    management_status=coalesce(?, management_status),
    title=coalesce(?, title),
    summary=CASE WHEN ? = 1 THEN ? ELSE summary END,
    author=CASE WHEN ? = 1 THEN ? ELSE author END,
    updated_at=?, revision=? WHERE id=?`)
    .run(
      input.verificationStatus ?? null,
      input.managementStatus ?? null,
      title ?? null,
      input.summary !== undefined ? 1 : 0,
      input.summary !== undefined ? input.summary : null,
      input.author !== undefined ? 1 : 0,
      input.author !== undefined ? input.author : null,
      new Date().toISOString(),
      next,
      input.id
    );
  if (broadcast) broadcastDataChanged({ scopes: ['library', 'sources', 'today'], reason: 'source.update' });
  // WMB-5238：Source 状态/字段更新成功提交后增量投影（含归档 → 移除索引条目）。
  projectSourceSaved(database, input.id);
  enqueueKnowledgeRouteJob(database, { sourceId: input.id, revision: next });
  wakePersistentKnowledgeJobs();
  return { id: input.id, revision: next };
}

export function deleteKnowledgeSource(database: DatabaseSync, input: { id: string; expectedRevision: number }, transaction = true, broadcast = true, options: { forceReferencedDelete?: boolean } = {}) {
  const current = database.prepare('SELECT id, revision FROM source_items WHERE id=?').get(input.id) as { id: string; revision: number } | undefined;
  if (!current) throw new Error('SOURCE_NOT_FOUND');
  if (current.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
  // WMB-5247 删除门：有外部 Asset 引用时阻止普通删除；forceReferencedDelete 仅表示用户显式
  // 确认“仍删除 Source 关系”，Asset 字节永不删除（字节由引用感知 GC 另行保护）。
  const gate = sourceDeleteGate(database, input.id, { forceReferencedDelete: options.forceReferencedDelete === true });
  if (!gate.allowed) {
    throw new CommandDispatchError(
      'SOURCE_DELETE_BLOCKED_REFERENCED_ASSETS',
      '该资料关联的素材仍被内容/平台版本、发布快照或知识证据引用；请先查看引用清单。确认后仍可删除资料（素材文件保留）。',
      { summary: gate.summary }
    );
  }
  if (transaction) database.exec('BEGIN');
  try {
    unlinkSourceTopicLinks(database, input.id);
    database.prepare('DELETE FROM content_project_sources WHERE source_id=?').run(input.id);
    purgeSourceBodyHistory(database, input.id);
    database.prepare('DELETE FROM source_body_cache WHERE source_id=?').run(input.id);
    try {
      database.prepare("DELETE FROM knowledge_canvas_nodes WHERE object_type='source' AND object_id=?").run(input.id);
    } catch {
      // canvas table may not exist in stripped fixtures
    }
    const result = database.prepare('DELETE FROM source_items WHERE id=?').run(input.id);
    if (!result.changes) throw new Error('SOURCE_NOT_FOUND');
    if (transaction) database.exec('COMMIT');
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
  if (broadcast) broadcastDataChanged({ scopes: ['library', 'sources', 'today'], reason: 'source.delete' });
  // WMB-5238：删除成功提交后移除索引条目（对象不存在 → projectSourceSaved 走 remove 分支）。
  projectSourceSaved(database, input.id);
  return { id: input.id, deleted: true as const };
}

export function listWatchingSources(database: DatabaseSync, limit = 30) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  return database.prepare(`
    SELECT s.id, s.title, s.original_url AS originalUrl, s.author, s.published_at AS publishedAt,
      s.collected_at AS collectedAt, s.summary, s.priority, s.verification_status AS verificationStatus,
      s.management_status AS managementStatus, s.revision,
      coalesce((SELECT group_concat(t.title, '、') FROM topic_source_links l JOIN topics t ON t.id=l.topic_id WHERE l.source_id=s.id), '') AS topics,
      (SELECT count(*) FROM plan_items pi, json_each(pi.source_ids_json) j WHERE j.value=s.id) AS opportunityCount,
      (SELECT count(*) FROM content_project_sources cps WHERE cps.source_id=s.id) AS projectCount,
      (SELECT count(*) FROM content_project_sources cps JOIN content_projects cp ON cp.id=cps.project_id
        JOIN content_versions cv ON cv.project_id=cp.id JOIN platform_versions pv ON pv.content_version_id=cv.id
        JOIN publications p ON p.platform_version_id=pv.id WHERE cps.source_id=s.id AND p.status='published') AS publicationCount
    FROM source_items s
    WHERE s.management_status = 'watching'
    ORDER BY s.updated_at DESC, s.collected_at DESC
    LIMIT ?
  `).all(safeLimit);
}

export function markSourcesWatching(database: DatabaseSync, sourceIds: string[], broadcast = true): { updated: number; ids: string[] } {
  const unique = [...new Set(sourceIds.filter(Boolean))];
  if (!unique.length) return { updated: 0, ids: [] };
  const now = new Date().toISOString();
  let updated = 0;
  const ids: string[] = [];
  const select = database.prepare('SELECT id, revision, management_status AS managementStatus FROM source_items WHERE id = ?');
  const update = database.prepare(`UPDATE source_items
    SET management_status = 'watching', updated_at = ?, revision = revision + 1
    WHERE id = ?`);
  for (const id of unique) {
    const row = select.get(id) as { id: string; revision: number; managementStatus: string } | undefined;
    if (!row) continue;
    if (row.managementStatus === 'watching') {
      ids.push(row.id);
      continue;
    }
    update.run(now, id);
    enqueueKnowledgeRouteJob(database, { sourceId: id, revision: row.revision + 1 });
    updated += 1;
    ids.push(id);
  }
  if (updated > 0) wakePersistentKnowledgeJobs();
  if (updated > 0 && broadcast) broadcastDataChanged({ scopes: ['library', 'sources', 'today'], reason: 'source.watching' });
  return { updated, ids };
}

export function upsertKnowledgeTopic(database: DatabaseSync, input: {
  canonicalKey?: string; title: string; kind?: 'theme' | 'event'; summary?: string; status?: TopicStatus;
}) {
  const key = normalizeTopicKey(input.canonicalKey ?? input.title);
  if (!key || !input.title.trim()) throw new Error('TOPIC_REQUIRED');
  if (input.status && !topicStatuses.has(input.status)) throw new Error('INVALID_TOPIC_STATUS');
  const now = new Date().toISOString();
  const existing = database.prepare('SELECT id, revision, title, kind, summary, status FROM topics WHERE canonical_key=?').get(key) as
    | { id: string; revision: number; title: string; kind: string | null; summary: string | null; status: string }
    | undefined;
  if (existing) {
    const nextTitle = input.title.trim();
    const nextKind = input.kind ?? 'theme';
    const nextStatus = input.status ?? existing.status;
    database.prepare(`UPDATE topics SET title=?, kind=?, summary=coalesce(?, summary), status=coalesce(?, status),
      last_seen_at=?, updated_at=?, revision=revision+1 WHERE id=?`)
      .run(nextTitle, nextKind, input.summary ?? null, nextStatus, now, now, existing.id);
    // WMB-5238：Topic 更新成功提交后增量投影（含归档 → 移除索引条目）；无实质变化不重复投影/日志。
    if (nextTitle !== existing.title || nextKind !== existing.kind || nextStatus !== existing.status
      || (input.summary !== undefined && input.summary !== existing.summary)) {
      projectTopicSaved(database, existing.id);
    }
    return { id: existing.id, created: false, revision: existing.revision + 1 };
  }
  const id = randomUUID();
  database.prepare(`INSERT INTO topics
    (id,title,created_at,updated_at,revision,canonical_key,kind,summary,status,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,1,?,?,?,?,?,?)`)
    .run(id, input.title.trim(), now, now, key, input.kind ?? 'theme', input.summary ?? null, input.status ?? 'active', now, now);
  // WMB-5238：新建 Topic 增量投影（索引 + 日志）。
  projectTopicSaved(database, id);
  return { id, created: true, revision: 1 };
}

/**
 * 统一的 Source→Topic 关系写入口。
 * 关系、当前 Source revision 对应的知识编译 job 与 Topic 时间线必须在同一调用方事务内写入；
 * 调用方提交事务后再调用 wakePersistentKnowledgeJobs()。
 */
export function linkTopicSource(database: DatabaseSync, input: {
  topicId: string;
  sourceId: string;
  relation?: TopicRelation;
  now?: string;
}): void {
  const topic = database.prepare('SELECT id FROM topics WHERE id=?').get(input.topicId) as { id: string } | undefined;
  if (!topic) throw new Error('TOPIC_NOT_FOUND');
  const source = database.prepare('SELECT id, revision FROM source_items WHERE id=?').get(input.sourceId) as { id: string; revision: number } | undefined;
  if (!source) throw new Error('SOURCE_NOT_FOUND');
  const now = input.now ?? new Date().toISOString();
  database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`)
    .run(input.topicId, input.sourceId, input.relation ?? 'primary', now, now);
  enqueueKnowledgeCompileJob(database, { sourceId: source.id, revision: source.revision, topicId: input.topicId });
  database.prepare('UPDATE topics SET last_seen_at=?, updated_at=?, revision=revision+1 WHERE id=?').run(now, now, input.topicId);
}

/** 批量关系写入：校验所有 Source 后再写，避免部分关系成功。 */
export function linkTopicSources(database: DatabaseSync, topicId: string, sourceIds: readonly string[], now = new Date().toISOString()): void {
  const unique = [...new Set(sourceIds.filter(Boolean))];
  const topic = database.prepare('SELECT id FROM topics WHERE id=?').get(topicId) as { id: string } | undefined;
  if (!topic) throw new Error('TOPIC_NOT_FOUND');
  const sources = unique.map((sourceId) => {
    const row = database.prepare('SELECT id, revision FROM source_items WHERE id=?').get(sourceId) as { id: string; revision: number } | undefined;
    if (!row) throw new Error('SOURCE_NOT_FOUND');
    return row;
  });
  const insert = database.prepare(`INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(topic_id,source_id,relation) DO UPDATE SET updated_at=excluded.updated_at`);
  for (const source of sources) {
    insert.run(topicId, source.id, 'primary', now, now);
    enqueueKnowledgeCompileJob(database, { sourceId: source.id, revision: source.revision, topicId });
  }
  if (sources.length) database.prepare('UPDATE topics SET last_seen_at=?, updated_at=?, revision=revision+1 WHERE id=?').run(now, now, topicId);
}

/** Topic maintenance 的原子移链入口；目标关系成功后立即按当前 Source revision 排队编译。 */
export function moveTopicSourceLink(database: DatabaseSync, input: {
  fromTopicId: string;
  toTopicId: string;
  sourceId: string;
  relation?: string;
  createdAt?: string;
  now?: string;
}): void {
  if (input.fromTopicId === input.toTopicId) throw new Error('TOPIC_REASSIGN_SAME');
  const relationFilter = input.relation === undefined ? '' : ' AND relation=?';
  const params = input.relation === undefined
    ? [input.fromTopicId, input.sourceId]
    : [input.fromTopicId, input.sourceId, input.relation];
  const row = database.prepare(`SELECT relation, created_at AS createdAt FROM topic_source_links
    WHERE topic_id=? AND source_id=?${relationFilter} ORDER BY relation LIMIT 1`).get(...params) as { relation: string; createdAt: string } | undefined;
  if (!row) throw new Error('TOPIC_REASSIGN_LINK_NOT_FOUND');
  const target = database.prepare('SELECT id FROM topics WHERE id=?').get(input.toTopicId) as { id: string } | undefined;
  if (!target) throw new Error('TOPIC_NOT_FOUND');
  const source = database.prepare('SELECT id, revision FROM source_items WHERE id=?').get(input.sourceId) as { id: string; revision: number } | undefined;
  if (!source) throw new Error('SOURCE_NOT_FOUND');
  const now = input.now ?? new Date().toISOString();
  database.prepare('DELETE FROM topic_source_links WHERE topic_id=? AND source_id=? AND relation=?')
    .run(input.fromTopicId, input.sourceId, row.relation);
  database.prepare(`INSERT OR IGNORE INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at)
    VALUES(?,?,?,?,?)`).run(input.toTopicId, input.sourceId, row.relation, input.createdAt ?? row.createdAt, now);
  enqueueKnowledgeCompileJob(database, { sourceId: source.id, revision: source.revision, topicId: input.toTopicId });
  database.prepare('UPDATE topics SET last_seen_at=?, updated_at=?, revision=revision+1 WHERE id IN (?,?)').run(now, now, input.fromTopicId, input.toTopicId);
}

/** 删除 Source 时只清理关系；删除本身不应再创建编译任务。 */
export function unlinkSourceTopicLinks(database: DatabaseSync, sourceId: string): void {
  database.prepare('DELETE FROM topic_source_links WHERE source_id=?').run(sourceId);
}

export function recordKnowledgeBatch(database: DatabaseSync, input: { items: Array<{
  sourceId: string; topic: { canonicalKey?: string; title: string; kind?: 'theme' | 'event'; summary?: string };
  relation?: TopicRelation; verificationStatus?: VerificationStatus; managementStatus?: ManagementStatus;
}> }, transaction = true) {
  if (!input.items.length) throw new Error('KNOWLEDGE_ITEMS_REQUIRED');
  const now = new Date().toISOString();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    const results = input.items.map((item) => {
      const source = database.prepare('SELECT revision FROM source_items WHERE id=?').get(item.sourceId) as { revision: number } | undefined;
      if (!source) throw new Error('SOURCE_NOT_FOUND');
      const topic = upsertKnowledgeTopic(database, item.topic);
      if (item.verificationStatus || item.managementStatus) {
        updateKnowledgeSource(database, { id: item.sourceId, expectedRevision: source.revision,
          verificationStatus: item.verificationStatus, managementStatus: item.managementStatus }, transaction);
      }
      linkTopicSource(database, { topicId: topic.id, sourceId: item.sourceId, relation: item.relation, now });
      return { sourceId: item.sourceId, topicId: topic.id };
    });
    if (transaction) database.exec('COMMIT');
    if (transaction) wakePersistentKnowledgeJobs();
    return results;
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
}

export function listKnowledgeTopics(database: DatabaseSync, input: { query?: string; status?: TopicStatus; limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100), offset = Math.max(input.offset ?? 0, 0);
  const query = input.query?.trim() ?? '', pattern = `%${query}%`;
  const statusFilter = input.status ?? '';
  if (statusFilter && !topicStatuses.has(statusFilter)) throw new Error('INVALID_TOPIC_STATUS');
  const includeArchived = statusFilter ? 1 : 0;
  const where = `(?='' OR t.title LIKE ? OR coalesce(t.summary,'') LIKE ?) AND (?='' OR t.status=?) AND (?=1 OR t.status!='archived')`;
  const filterArgs = [query, pattern, pattern, statusFilter, statusFilter, includeArchived] as const;
  const total = Number((database.prepare(`SELECT count(*) AS count FROM topics t WHERE ${where}`).get(...filterArgs) as { count: number }).count);
  const items = database.prepare(`SELECT t.id,t.title,t.canonical_key AS canonicalKey,t.kind,t.summary,t.status,
    t.first_seen_at AS firstSeenAt,t.last_seen_at AS lastSeenAt,t.revision,
    count(DISTINCT l.source_id) AS sourceCount,
    count(DISTINCT pi.id) AS opportunityCount,
    (
      SELECT count(DISTINCT cp.id) FROM content_projects cp
      WHERE cp.topic_id=t.id OR EXISTS(
        SELECT 1 FROM content_project_sources cps
        JOIN topic_source_links linked ON linked.source_id=cps.source_id
        WHERE cps.project_id=cp.id AND linked.topic_id=t.id
      )
    ) AS contentCount,
    (
      SELECT count(DISTINCT p.id) FROM content_projects cp
      JOIN content_versions cv ON cv.project_id=cp.id
      JOIN platform_versions pv ON pv.content_version_id=cv.id
      JOIN publications p ON p.platform_version_id=pv.id
      WHERE p.status='published' AND (
        cp.topic_id=t.id OR EXISTS(
          SELECT 1 FROM content_project_sources cps
          JOIN topic_source_links linked ON linked.source_id=cps.source_id
          WHERE cps.project_id=cp.id AND linked.topic_id=t.id
        )
      )
    ) AS publicationCount
    FROM topics t
    LEFT JOIN topic_source_links l ON l.topic_id=t.id
    LEFT JOIN plan_items pi ON pi.topic_id=t.id
    WHERE ${where}
    GROUP BY t.id ORDER BY t.last_seen_at DESC,t.id DESC LIMIT ? OFFSET ?`)
    .all(...filterArgs, limit, offset);
  // WMB-5233：诚实三态（复用同一判定；列表投影一次 join 批量读回）。
  const compileStates = listTopicCompileStates(database, items.map((row) => String(row.id)));
  const enriched = items.map((row) => ({ ...row, compileState: compileStates.get(String(row.id)) ?? 'uncompiled' }));
  return { items: enriched, total, limit, offset, hasMore: offset + items.length < total };
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

function parseIdArrayJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * WMB-5214：冻结飞轮知识版本（Pi 查询读取面）。只返回真实存在且已落库的固定版本：
 * Topic Wiki 当前版本 + 其采纳的 Note 版本 + 这些 Note 版本挂载的 Evidence（带 id）。
 * Pi 的 Query 写回 manifest 只能引用本集合（服务端存在性 + basedOn ⊆ read 双校验）；
 * 回答本身不是证据，综合候选的证据关系 derived_from 指向这里返回的版本 id。
 */
export function resolveFixedKnowledgeVersions(
  database: DatabaseSync,
  topicIds: readonly string[],
  limit: number
): { wikiPages: unknown[]; noteVersions: unknown[]; evidence: unknown[] } {
  if (!topicIds.length) return { wikiPages: [], noteVersions: [], evidence: [] };
  const placeholders = topicIds.map(() => '?').join(',');
  const wikiPages = database.prepare(`
    SELECT p.id AS pageId, p.page_type AS pageType, p.title, p.compile_status AS compileStatus,
           p.subject_id AS subjectId, p.current_version_id AS currentVersionId,
           pv.version_number AS versionNumber, pv.adopted_note_version_ids_json AS adoptedNoteVersionIds
    FROM knowledge_wiki_pages p
    LEFT JOIN knowledge_wiki_page_versions pv ON pv.id = p.current_version_id
    WHERE p.lifecycle = 'active' AND p.subject_type = 'topic' AND p.subject_id IN (${placeholders})
    ORDER BY p.updated_at DESC LIMIT ?
  `).all(...topicIds, limit);
  const adopted = new Set<string>();
  for (const row of wikiPages as Array<{ adoptedNoteVersionIds?: string }>) {
    for (const id of parseIdArrayJson(String(row.adoptedNoteVersionIds ?? '[]'))) adopted.add(id);
  }
  const noteVersionIds = [...adopted].slice(0, limit);
  const noteVersions = noteVersionIds.length
    ? database.prepare(`
        SELECT nv.id AS versionId, nv.note_id AS noteId, n.kind AS kind, nv.title, nv.statement,
               nv.conclusion_status AS conclusionStatus, nv.evidence_level AS evidenceLevel,
               nv.applies_to AS appliesTo, nv.adopted_topic_ids_json AS adoptedTopicIds
        FROM knowledge_note_versions nv JOIN knowledge_notes n ON n.id = nv.note_id
        WHERE nv.id IN (${noteVersionIds.map(() => '?').join(',')})
      `).all(...noteVersionIds)
    : [];
  const evidence = noteVersionIds.length
    ? database.prepare(`
        SELECT id, knowledge_note_version_id AS noteVersionId, evidence_object_type AS evidenceObjectType,
               evidence_object_id AS evidenceObjectId, relation, source_nature AS sourceNature,
               excerpt, locator
        FROM knowledge_evidence_links
        WHERE knowledge_note_version_id IN (${noteVersionIds.map(() => '?').join(',')})
        ORDER BY created_at DESC LIMIT ?
      `).all(...noteVersionIds, limit)
    : [];
  return { wikiPages, noteVersions, evidence };
}

export function getKnowledgeContext(database: DatabaseSync, input: { topicId?: string; sourceId?: string; query?: string; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const topicIds = input.topicId ? [input.topicId] : input.sourceId
    ? (database.prepare('SELECT topic_id AS id FROM topic_source_links WHERE source_id=?').all(input.sourceId) as Array<{ id: string }>).map((r) => r.id)
    : (database.prepare("SELECT id FROM topics WHERE title LIKE ? ORDER BY last_seen_at DESC LIMIT ?").all(`%${input.query ?? ''}%`, limit) as Array<{ id: string }>).map((r) => r.id);
  const sourceIds = input.sourceId ? [input.sourceId] : topicIds.length
    ? (database.prepare(`SELECT DISTINCT source_id AS id FROM topic_source_links WHERE topic_id IN (${topicIds.map(() => '?').join(',')}) LIMIT ?`).all(...topicIds, limit) as Array<{ id: string }>).map((r) => r.id) : [];
  const topics = topicIds.length ? database.prepare(`SELECT id,title,kind,summary,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt FROM topics WHERE id IN (${topicIds.map(() => '?').join(',')})`).all(...topicIds) : [];
  // 有效资料库口径：知识上下文只带回未移出（archived）资料；已移出条目经「已移出」视图（4944）单独可查。
  const sources = sourceIds.length ? database.prepare(`SELECT id,title,original_url AS originalUrl,summary,priority,verification_status AS verificationStatus,management_status AS managementStatus,collected_at AS collectedAt FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')}) AND management_status != 'archived'`).all(...sourceIds) : [];
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
  // WMB-5214：冻结飞轮知识版本（Pi 读取面；QueryArtifact 写回据此引用固定版本，回答本身不是证据）。
  const knowledge = resolveFixedKnowledgeVersions(database, topicIds, limit);
  return { topics, sources, opportunities, projects, publications, metrics, reviews, findings, knowledge };
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
      json_object('relation',CASE WHEN max(tsl.relation='contradicting')=1 THEN 'contradicting' ELSE min(tsl.relation) END,'verificationStatus',s.verification_status,'managementStatus',s.management_status,'revision',s.revision,'originalUrl',s.original_url) metadataJson
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
    ORDER BY s.priority,s.collected_at DESC LIMIT 20`).all() as Array<Record<string, unknown>>;
  const watching = database.prepare(`SELECT id,title,priority,collected_at AS collectedAt,'持续观察' AS reason FROM source_items
    WHERE management_status='watching' ORDER BY collected_at DESC LIMIT 20`).all() as Array<Record<string, unknown>>;
  const pending = database.prepare(`SELECT id,title,priority,collected_at AS collectedAt,'待核验超过 7 天' AS reason FROM source_items
    WHERE verification_status='pending' AND collected_at < datetime('now','-7 days') ORDER BY collected_at DESC LIMIT 20`).all() as Array<Record<string, unknown>>;
  // WMB-5212：每项附加该 Source 最近一次知识回执（证据变化摘要；有界单条）。
  const withReceipt = (items: Array<Record<string, unknown>>) => items.map((item) => {
    const id = String(item.id);
    const latest = listUpdateReceipts(database, { sourceId: id, limit: 1 }).items[0] ?? null;
    return { ...item, latestReceipt: latest };
  });
  return { unused: withReceipt(unused), watching: withReceipt(watching), pending: withReceipt(pending) };
}

function normalizeTopicKey(value: string) { return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }
