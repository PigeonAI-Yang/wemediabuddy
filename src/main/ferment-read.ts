import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { markSourcesWatching } from './knowledge.ts';
import {
  fingerprintPlanItem,
  isMultiDayTimeliness,
  shanghaiDate,
  type AftershockItem,
  type CarryObjectType,
  type CarryState,
  type WorkCarryItem
} from './ferment.ts';

const MAX_PINNED_SOURCES = 3;

type CarryRow = {
  id: string; objectType: WorkCarryItem['objectType']; objectId: string; fingerprint: string; title: string; state: CarryState;
  priority: number | null; topicId: string | null; sourceIds: string; originPlanDate: string | null; firstSeenAt: string;
  lastSeenAt: string; expiresAt: string; decayScore: number; reason: string | null; aftershocks: string;
  createdAt: string; updatedAt: string; revision: number; storyKey: string | null; stage: WorkCarryItem['stage'];
};

export function listPinnedSources(database: DatabaseSync, planDate: string, fermenting: WorkCarryItem[]) {
  const ids = new Set<string>();
  for (const item of fermenting) for (const id of item.sourceIds) ids.add(id);
  const sourceCarry = listCarryItems(database, { states: ['active', 'watching'], limit: 20, planDate })
    .filter((item) => item.objectType === 'source');
  for (const item of sourceCarry) ids.add(item.objectId);
  if (!ids.size) return [];
  const rows = database.prepare(`SELECT id, title, collected_at AS collectedAt, priority, summary, canonical_url AS canonicalUrl
    FROM source_items
    WHERE id IN (${[...ids].map(() => '?').join(',')})
    ORDER BY COALESCE(priority, 9) ASC, collected_at DESC
    LIMIT ?`).all(...ids, MAX_PINNED_SOURCES) as Array<{
    id: string;
    title: string;
    collectedAt: string;
    priority: number | null;
    summary: string | null;
    canonicalUrl: string | null;
  }>;
  return rows.map((row) => ({
    ...row,
    fermentedDays: daysBetween(row.collectedAt, planDate),
    reason: '跨日重点资料'
  }));
}

export function listCarryItems(database: DatabaseSync, input: { states?: CarryState[]; limit?: number; planDate?: string } = {}): WorkCarryItem[] {
  const states = input.states?.length ? input.states : ['active', 'watching', 'done', 'dismissed', 'expired'];
  const limit = input.limit ?? 50;
  const planDate = input.planDate ?? shanghaiDate();
  const rows = database.prepare(`SELECT id, object_type AS objectType, object_id AS objectId, fingerprint, title, state,
      priority, topic_id AS topicId, source_ids_json AS sourceIds, origin_plan_date AS originPlanDate,
      first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, decay_score AS decayScore,
      reason, aftershock_json AS aftershocks, created_at AS createdAt, updated_at AS updatedAt, revision,
      story_key AS storyKey, stage
    FROM work_carry_items
    WHERE state IN (${states.map(() => '?').join(',')})
    ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END,
      COALESCE(priority, 9) ASC, decay_score DESC, last_seen_at DESC
    LIMIT ?`).all(...states, limit) as CarryRow[];
  return rows.map((row) => parseCarryRow(row, planDate));
}

export function getCarryItem(database: DatabaseSync, id: string, planDate = shanghaiDate()): WorkCarryItem | null {
  const row = database.prepare(`SELECT id, object_type AS objectType, object_id AS objectId, fingerprint, title, state,
      priority, topic_id AS topicId, source_ids_json AS sourceIds, origin_plan_date AS originPlanDate,
      first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, decay_score AS decayScore,
      reason, aftershock_json AS aftershocks, created_at AS createdAt, updated_at AS updatedAt, revision,
      story_key AS storyKey, stage
    FROM work_carry_items WHERE id=?`).get(id) as CarryRow | undefined;
  return row ? parseCarryRow(row, planDate) : null;
}

function parseCarryRow(row: CarryRow, planDate: string): WorkCarryItem {
  const originOrFirst = row.originPlanDate || row.firstSeenAt;
  return {
    id: row.id,
    objectType: row.objectType,
    objectId: row.objectId,
    fingerprint: row.fingerprint,
    title: row.title,
    state: row.state,
    priority: row.priority,
    topicId: row.topicId,
    sourceIds: JSON.parse(row.sourceIds || '[]') as string[],
    originPlanDate: row.originPlanDate,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    decayScore: Number(row.decayScore || 0),
    reason: row.reason,
    aftershocks: JSON.parse(row.aftershocks || '[]') as AftershockItem[],
    fermentedDays: daysBetween(originOrFirst, planDate),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    storyKey: row.storyKey,
    stage: row.stage
  };
}

export function expireDueCarryItems(database: DatabaseSync): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE work_carry_items
    SET state='expired', updated_at=?, revision=revision+1
    WHERE state IN ('active','watching') AND expires_at < ?`).run(now, now);
}

export function promoteCarryWatchingToLibrary(database: DatabaseSync): void {
  const rows = database.prepare(`SELECT id, source_ids_json AS sourceIds
    FROM work_carry_items WHERE state = 'watching'`).all() as Array<{ id: string; sourceIds: string }>;
  if (!rows.length) return;
  const now = new Date().toISOString();
  for (const row of rows) {
    const sourceIds = JSON.parse(row.sourceIds || '[]') as string[];
    if (sourceIds.length) markSourcesWatching(database, sourceIds);
    database.prepare(`UPDATE work_carry_items
      SET state = 'dismissed', updated_at = ?, revision = revision + 1
      WHERE id = ?`).run(now, row.id);
  }
}

type TodayPlanDedup = {
  itemIds: Set<string>;
  titles: Set<string>;
  sourceIds: Set<string>;
  fingerprints: Set<string>;
};

export function loadTodayPlanDedup(database: DatabaseSync, planDate: string): TodayPlanDedup {
  const rows = database.prepare(`SELECT pi.id, pi.title, pi.topic_id AS topicId, pi.source_ids_json AS sourceIds
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE p.plan_date = ? AND p.is_current = 1`).all(planDate) as Array<{
    id: string;
    title: string;
    topicId: string | null;
    sourceIds: string;
  }>;
  const itemIds = new Set<string>();
  const titles = new Set<string>();
  const sourceIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const row of rows) {
    itemIds.add(row.id);
    titles.add(normalizeTitle(row.title));
    const ids = JSON.parse(row.sourceIds || '[]') as string[];
    for (const id of ids) sourceIds.add(id);
    fingerprints.add(fingerprintPlanItem({ title: row.title, topicId: row.topicId, sourceIds: ids }));
  }
  return { itemIds, titles, sourceIds, fingerprints };
}

export function isCoveredByTodayPlan(item: WorkCarryItem, today: TodayPlanDedup, planDate: string): boolean {
  if (item.originPlanDate === planDate) return true;
  if (item.objectType === 'plan_item') {
    if (today.itemIds.has(item.objectId)) return true;
    if (today.fingerprints.has(item.fingerprint)) return true;
    if (today.titles.has(normalizeTitle(item.title))) return true;
  }
  if (item.objectType === 'source' && today.sourceIds.has(item.objectId)) return true;
  if (item.sourceIds.some((id) => today.sourceIds.has(id))) {
    // Same evidence already used by today's plan — treat as covered.
    if (item.objectType === 'plan_item' || item.objectType === 'source') return true;
  }
  return false;
}

export function hasProjectForPlanItemOrSources(database: DatabaseSync, planItemId: string, sourceIds: string[]): boolean {
  const byPlan = database.prepare(`SELECT id FROM content_projects WHERE plan_item_id=? AND archived_at IS NULL LIMIT 1`).get(planItemId);
  if (byPlan) return true;
  if (!sourceIds.length) return false;
  const row = database.prepare(`SELECT 1 AS ok FROM content_project_sources cps
    JOIN content_projects cp ON cp.id = cps.project_id
    WHERE cp.archived_at IS NULL AND cps.source_id IN (${sourceIds.map(() => '?').join(',')})
    LIMIT 1`).get(...sourceIds) as { ok: number } | undefined;
  return Boolean(row);
}
export function compareCarry(a: WorkCarryItem, b: WorkCarryItem): number {
  const stateRank = (state: CarryState) => (state === 'active' ? 0 : state === 'watching' ? 1 : 2);
  const typeRank = (type: CarryObjectType) => (type === 'plan_item' ? 0 : type === 'source' ? 1 : 2);
  return stateRank(a.state) - stateRank(b.state)
    || typeRank(a.objectType) - typeRank(b.objectType)
    || (a.priority ?? 9) - (b.priority ?? 9)
    || b.decayScore - a.decayScore
    || b.lastSeenAt.localeCompare(a.lastSeenAt);
}

export function defaultReason(priority: number, timeliness: string): string {
  if (isMultiDayTimeliness(timeliness)) return `未完结影响：${timeliness}`;
  if (priority <= 1) return '高优先级机会，持续关注';
  return '待处理机会';
}

export function normalizeTitle(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
}

/** 去时态/修饰词后的故事标题，仅用于 story 身份，不用于展示。 */
export function normalizeStoryTitle(value: string): string {
  return normalizeTitle(value)
    .replace(/(又|再|最新|疑似|通报|更新了吗|更新了|更新|再发|持续|突发|重磅)/g, ' ')
    .replace(/[：:，,。.!！?？、|+\-—_/\\()（）[\]【】「」""'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleBigrams(value: string): Set<string> {
  const compact = normalizeStoryTitle(value).replace(/\s+/g, '');
  const grams = new Set<string>();
  if (compact.length <= 1) {
    if (compact) grams.add(compact);
    return grams;
  }
  for (let i = 0; i < compact.length - 1; i += 1) grams.add(compact.slice(i, i + 2));
  return grams;
}

export function bigramJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

export function sourcesOverlap(a: string[] = [], b: string[] = []): { shared: number; jaccard: number } {
  const left = new Set(a.filter(Boolean));
  const right = new Set(b.filter(Boolean));
  if (!left.size || !right.size) return { shared: 0, jaccard: 0 };
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  return { shared, jaccard: shared / new Set([...left, ...right]).size };
}

export type StoryIdentity = { title: string; topicId?: string | null; sourceIds?: string[] };

/**
 * 确定性故事身份键（完整版 story_key 落库列）：topicId 优先 → 来源核心集 → 规范化标题 bigram。
 * 来源集/标题变化会使 sources:/title: 前缀键漂移，refresh 时由 mergeSimilarCarryItems 按 sameStory
 * 收敛（合并行继承 keeper 键），topic: 前缀键天然跨日稳定。
 */
export function storyKeyOf(input: { title: string; topicId?: string | null; sourceIds?: string[] }): string | null {
  const topicId = input.topicId ?? null;
  if (topicId) return `topic:${topicId}`;
  const sources = [...new Set((input.sourceIds ?? []).filter(Boolean))].sort();
  if (sources.length) {
    return `sources:${createHash('sha256').update(sources.join('\u0000')).digest('hex').slice(0, 32)}`;
  }
  const grams = [...titleBigrams(input.title)].sort();
  if (!grams.length) return null;
  return `title:${createHash('sha256').update(grams.join('\u0000')).digest('hex').slice(0, 32)}`;
}

/** topicId → 来源重合 → 规范化标题 bigram；命中即同一故事。 */
export function sameStory(a: StoryIdentity, b: StoryIdentity): boolean {
  if (a.topicId && b.topicId && a.topicId === b.topicId) return true;
  const { shared, jaccard } = sourcesOverlap(a.sourceIds, b.sourceIds);
  if (shared >= 2 || jaccard >= 0.5) return true;
  return bigramJaccard(titleBigrams(a.title), titleBigrams(b.title)) >= 0.5;
}

/** 持续关注闸门：有余波，或 reason/未完结语义标记。 */
export function hasWhyWatching(item: { aftershocks?: AftershockItem[]; reason?: string | null }): boolean {
  if ((item.aftershocks?.length ?? 0) > 0) return true;
  const reason = item.reason ?? '';
  return /未完结|持续关注|政策后续|多日|跟踪|余波|跟进|为何关注/.test(reason);
}

export function toUtcIsoBound(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function addDaysDate(planDate: string, days: number): string {
  const date = new Date(`${planDate}T12:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return shanghaiDate(date);
}

export function daysBetween(fromIsoOrDate: string, toPlanDate: string): number {
  const from = fromIsoOrDate.length <= 10
    ? new Date(`${fromIsoOrDate}T12:00:00+08:00`)
    : new Date(fromIsoOrDate);
  const to = new Date(`${toPlanDate}T12:00:00+08:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}
