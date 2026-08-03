import type { DatabaseSync } from 'node:sqlite';
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
  createdAt: string; updatedAt: string; revision: number;
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
      reason, aftershock_json AS aftershocks, created_at AS createdAt, updated_at AS updatedAt, revision
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
      reason, aftershock_json AS aftershocks, created_at AS createdAt, updated_at AS updatedAt, revision
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
    revision: row.revision
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
  if (priority <= 1) return '高优先级机会，默认跨日发酵';
  if (isMultiDayTimeliness(timeliness)) return `时效「${timeliness}」，进入多日跟踪`;
  return '未消化机会，短期续命';
}

export function normalizeTitle(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
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
