import { broadcastDataChanged } from './data-changed.ts';
import { markSourcesWatching } from './knowledge.ts';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type CarryObjectType = 'plan_item' | 'source' | 'topic';
export type CarryState = 'active' | 'watching' | 'done' | 'dismissed' | 'expired';

export type AftershockItem = {
  sourceId: string;
  title: string;
  collectedAt: string;
};

export type WorkCarryItem = {
  id: string;
  objectType: CarryObjectType;
  objectId: string;
  fingerprint: string;
  title: string;
  state: CarryState;
  priority: number | null;
  topicId: string | null;
  sourceIds: string[];
  originPlanDate: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  decayScore: number;
  reason: string | null;
  aftershocks: AftershockItem[];
  fermentedDays: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type FermentingBundle = {
  items: WorkCarryItem[];
  watchingItems: WorkCarryItem[];
  topics: Array<{
    topicId: string;
    title: string;
    activeCount: number;
    watchingCount: number;
    latestTitle: string | null;
    fermentedDays: number;
  }>;
  pinnedSources: Array<{
    id: string;
    title: string;
    collectedAt: string;
    priority: number | null;
    summary: string | null;
    canonicalUrl: string | null;
    fermentedDays: number;
    reason: string;
  }>;
};

const DEFAULT_ACTIVE_DAYS = 7;
const DEFAULT_WATCH_DAYS = 14;
const MAX_FERMENTING = 5;
const MAX_PINNED_SOURCES = 3;

type CarryRow = {
  id: string;
  objectType: CarryObjectType;
  objectId: string;
  fingerprint: string;
  title: string;
  state: CarryState;
  priority: number | null;
  topicId: string | null;
  sourceIds: string;
  originPlanDate: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
  decayScore: number;
  reason: string | null;
  aftershocks: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export function shanghaiDate(value = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
}

export function fingerprintPlanItem(input: { title: string; topicId?: string | null; sourceIds?: string[] }): string {
  const title = normalizeTitle(input.title);
  const topic = input.topicId || '';
  const sources = [...new Set((input.sourceIds || []).filter(Boolean))].sort().join(',');
  return createHash('sha256').update(`plan_item|${topic}|${title}|${sources}`).digest('hex').slice(0, 32);
}

export function fingerprintSource(sourceId: string): string {
  return createHash('sha256').update(`source|${sourceId}`).digest('hex').slice(0, 32);
}

export function fingerprintTopic(topicId: string): string {
  return createHash('sha256').update(`topic|${topicId}`).digest('hex').slice(0, 32);
}

export function isMultiDayTimeliness(value: string | null | undefined): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  return /持续|多日|本周|这周|一周|7\s*天|长期|余波|跟踪|跟进|发酵|week|ongoing|multi/.test(text);
}
export function refreshWorkCarry(database: DatabaseSync, planDate = shanghaiDate()): FermentingBundle {
  expireDueCarryItems(database);
  promoteCarryWatchingToLibrary(database);
  seedCarryFromRecentPlans(database, planDate);
  seedCarryFromHighValueSources(database, planDate);
  seedCarryFromTopics(database, planDate);
  refreshAftershocks(database, planDate);
  recomputeDecayScores(database, planDate);
  return listFermentingBundle(database, planDate);
}

export function listFermentingBundle(database: DatabaseSync, planDate = shanghaiDate()): FermentingBundle {
  expireDueCarryItems(database);
  const todayPlan = loadTodayPlanDedup(database, planDate);
  const all = listCarryItems(database, { states: ['active', 'watching'], limit: 80, planDate })
    .filter((item) => item.objectType === 'plan_item' || item.objectType === 'source')
    .sort(compareCarry);

  // Active list is a diff against today's plan. Watching is user-pinned: always keep visible.
  const items = all
    .filter((item) => item.state === 'active')
    .filter((item) => !isCoveredByTodayPlan(item, todayPlan, planDate))
    .slice(0, MAX_FERMENTING);
  const watchingItems = all
    .filter((item) => item.state === 'watching')
    .slice(0, MAX_FERMENTING);

  const topicRows = database.prepare(`SELECT c.topic_id AS topicId, t.title AS title,
      sum(CASE WHEN c.state='active' THEN 1 ELSE 0 END) AS activeCount,
      sum(CASE WHEN c.state='watching' THEN 1 ELSE 0 END) AS watchingCount,
      max(c.last_seen_at) AS lastSeenAt,
      (SELECT c2.title FROM work_carry_items c2 WHERE c2.topic_id=c.topic_id AND c2.state IN ('active','watching') ORDER BY c2.priority ASC, c2.last_seen_at DESC LIMIT 1) AS latestTitle,
      min(c.first_seen_at) AS firstSeenAt,
      min(c.origin_plan_date) AS originPlanDate
    FROM work_carry_items c
    JOIN topics t ON t.id = c.topic_id
    WHERE c.topic_id IS NOT NULL AND c.state IN ('active','watching')
    GROUP BY c.topic_id
    ORDER BY activeCount DESC, watchingCount DESC, lastSeenAt DESC
    LIMIT 8`).all() as Array<{
    topicId: string;
    title: string;
    activeCount: number;
    watchingCount: number;
    lastSeenAt: string;
    latestTitle: string | null;
    firstSeenAt: string;
    originPlanDate: string | null;
  }>;

  return {
    items,
    watchingItems,
    topics: topicRows.map((row) => ({
      topicId: row.topicId,
      title: row.title,
      activeCount: Number(row.activeCount || 0),
      watchingCount: Number(row.watchingCount || 0),
      latestTitle: row.latestTitle,
      fermentedDays: daysBetween(row.originPlanDate || row.firstSeenAt, planDate)
    })),
    pinnedSources: listPinnedSources(database, planDate, items)
  };
}

export function setCarryState(
  database: DatabaseSync,
  input: { id: string; expectedRevision: number; state: CarryState; reason?: string }
): WorkCarryItem {
  const existing = getCarryItem(database, input.id);
  if (!existing) throw new Error('续命条目不存在。');
  if (existing.revision !== input.expectedRevision) throw new Error('续命条目已被更新，请刷新后重试。');
  const now = new Date().toISOString();
  const expiresAt = input.state === 'watching'
    ? addDaysIso(now, DEFAULT_WATCH_DAYS)
    : input.state === 'active'
      ? addDaysIso(now, DEFAULT_ACTIVE_DAYS)
      : existing.expiresAt;
  database.prepare(`UPDATE work_carry_items
    SET state=?, reason=COALESCE(?, reason), expires_at=?, updated_at=?, revision=revision+1
    WHERE id=?`).run(input.state, input.reason ?? null, expiresAt, now, input.id);
  const next = getCarryItem(database, input.id);
  if (!next) throw new Error('续命条目更新失败。');
  broadcastDataChanged({ scopes: ['today'], reason: 'carry.state' });
  return next;
}

export function markCarryDoneForPlanItem(database: DatabaseSync, planItemId: string): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE work_carry_items
    SET state='done', updated_at=?, revision=revision+1
    WHERE object_type='plan_item' AND object_id=? AND state IN ('active','watching')`).run(now, planItemId);

  const item = database.prepare(`SELECT title, topic_id AS topicId, source_ids_json AS sourceIds FROM plan_items WHERE id=?`).get(planItemId) as {
    title: string;
    topicId: string | null;
    sourceIds: string;
  } | undefined;
  if (!item) return;
  const fingerprint = fingerprintPlanItem({
    title: item.title,
    topicId: item.topicId,
    sourceIds: JSON.parse(item.sourceIds) as string[]
  });
  database.prepare(`UPDATE work_carry_items
    SET state='done', updated_at=?, revision=revision+1
    WHERE object_type='plan_item' AND fingerprint=? AND state IN ('active','watching')`).run(now, fingerprint);
}

export function upsertCarryFromPlanItem(
  database: DatabaseSync,
  input: {
    planItemId: string;
    title: string;
    priority: number;
    timeliness: string;
    topicId?: string | null;
    sourceIds: string[];
    originPlanDate: string;
    forceState?: CarryState;
    reason?: string;
  }
): WorkCarryItem | null {
  if (input.priority > 2 && !isMultiDayTimeliness(input.timeliness) && input.forceState !== 'active' && input.forceState !== 'watching') {
    return null;
  }
  if (hasProjectForPlanItemOrSources(database, input.planItemId, input.sourceIds)) {
    return null;
  }
  const fingerprint = fingerprintPlanItem(input);
  const now = new Date().toISOString();
  const existing = database.prepare(`SELECT id FROM work_carry_items WHERE object_type='plan_item' AND fingerprint=?`).get(fingerprint) as { id: string } | undefined;
  if (existing) {
    const current = getCarryItem(database, existing.id, input.originPlanDate);
    if (!current) return null;
    // Respect user parking: never auto-revive watching/done/dismissed from reseeding.
    if (current.state === 'done' || current.state === 'dismissed' || current.state === 'watching') return current;
    database.prepare(`UPDATE work_carry_items SET
      object_id=?, title=?, priority=?, topic_id=?, source_ids_json=?, origin_plan_date=COALESCE(origin_plan_date, ?),
      last_seen_at=?, expires_at=?, reason=COALESCE(?, reason), updated_at=?, revision=revision+1
      WHERE id=?`).run(
      input.planItemId,
      input.title,
      input.priority,
      input.topicId ?? null,
      JSON.stringify(input.sourceIds),
      input.originPlanDate,
      now,
      addDaysIso(now, DEFAULT_ACTIVE_DAYS),
      input.reason ?? null,
      now,
      existing.id
    );
    return getCarryItem(database, existing.id, input.originPlanDate);
  }

  const id = randomUUID();
  const state: CarryState = input.forceState ?? (input.priority <= 1 || isMultiDayTimeliness(input.timeliness) ? 'active' : 'watching');
  const expiresAt = addDaysIso(now, state === 'watching' ? DEFAULT_WATCH_DAYS : DEFAULT_ACTIVE_DAYS);
  database.prepare(`INSERT INTO work_carry_items (
      id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json, origin_plan_date,
      first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision
    ) VALUES (?, 'plan_item', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', ?, ?, 1)`).run(
    id,
    input.planItemId,
    fingerprint,
    input.title,
    state,
    input.priority,
    input.topicId ?? null,
    JSON.stringify(input.sourceIds),
    input.originPlanDate,
    now,
    now,
    expiresAt,
    input.reason ?? defaultReason(input.priority, input.timeliness),
    now,
    now
  );
  return getCarryItem(database, id, input.originPlanDate);
}

function seedCarryFromRecentPlans(database: DatabaseSync, planDate: string): void {
  const since = addDaysDate(planDate, -DEFAULT_ACTIVE_DAYS);
  const rows = database.prepare(`SELECT pi.id AS planItemId, pi.title, pi.priority, pi.timeliness, pi.topic_id AS topicId,
      pi.source_ids_json AS sourceIds, p.plan_date AS planDate
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE p.plan_date >= ? AND p.plan_date < ? AND p.is_current = 1
      AND pi.priority <= 2
    ORDER BY pi.priority ASC, p.plan_date DESC
    LIMIT 40`).all(since, planDate) as Array<{
    planItemId: string;
    title: string;
    priority: number;
    timeliness: string;
    topicId: string | null;
    sourceIds: string;
    planDate: string;
  }>;
  for (const row of rows) {
    upsertCarryFromPlanItem(database, {
      planItemId: row.planItemId,
      title: row.title,
      priority: row.priority,
      timeliness: row.timeliness,
      topicId: row.topicId,
      sourceIds: JSON.parse(row.sourceIds) as string[],
      originPlanDate: row.planDate,
      reason: row.planDate === addDaysDate(planDate, -1)
        ? '昨日高价值机会，跨日续命'
        : '近 7 日高价值未消化机会'
    });
  }
}

function seedCarryFromHighValueSources(database: DatabaseSync, planDate: string): void {
  const since = toUtcIsoBound(`${addDaysDate(planDate, -DEFAULT_ACTIVE_DAYS)}T00:00:00.000+08:00`);
  const dayStart = toUtcIsoBound(`${planDate}T00:00:00.000+08:00`);
  const rows = database.prepare(`SELECT s.id, s.title, s.priority, s.collected_at AS collectedAt
    FROM source_items s
    WHERE s.management_status != 'archived'
      AND s.priority IS NOT NULL AND s.priority <= 1
      AND s.collected_at >= ? AND s.collected_at < ?
      AND s.title NOT LIKE '[官宣巡检]%'
      AND NOT EXISTS(SELECT 1 FROM content_project_sources cps WHERE cps.source_id = s.id)
    ORDER BY s.priority ASC, s.collected_at DESC
    LIMIT 20`).all(since, dayStart) as Array<{
    id: string;
    title: string;
    priority: number;
    collectedAt: string;
  }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const fingerprint = fingerprintSource(row.id);
    const existing = database.prepare(`SELECT id, state FROM work_carry_items WHERE object_type='source' AND fingerprint=?`).get(fingerprint) as {
      id: string;
      state: CarryState;
    } | undefined;
    if (existing) {
      if (existing.state === 'done' || existing.state === 'dismissed' || existing.state === 'expired' || existing.state === 'watching') continue;
      database.prepare(`UPDATE work_carry_items SET last_seen_at=?, updated_at=?, revision=revision+1 WHERE id=?`).run(now, now, existing.id);
      continue;
    }
    const id = randomUUID();
    database.prepare(`INSERT INTO work_carry_items (
        id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json, origin_plan_date,
        first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision
      ) VALUES (?, 'source', ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?, ?, 1, ?, '[]', ?, ?, 1)`).run(
      id,
      row.id,
      fingerprint,
      row.title,
      row.priority,
      JSON.stringify([row.id]),
      shanghaiDate(new Date(row.collectedAt)),
      row.collectedAt,
      now,
      addDaysIso(now, DEFAULT_ACTIVE_DAYS),
      '高价值资料尚未创作，跨日钉住',
      now,
      now
    );
  }
}

function seedCarryFromTopics(database: DatabaseSync, planDate: string): void {
  const since = addDaysDate(planDate, -DEFAULT_ACTIVE_DAYS);
  const rows = database.prepare(`SELECT t.id AS topicId, t.title,
      count(DISTINCT pi.id) AS opportunityCount,
      min(p.plan_date) AS firstPlanDate,
      max(p.plan_date) AS lastPlanDate
    FROM topics t
    JOIN plan_items pi ON pi.topic_id = t.id
    JOIN plans p ON p.id = pi.plan_id AND p.is_current = 1
    WHERE p.plan_date >= ? AND p.plan_date <= ?
      AND t.status IN ('active','watching')
    GROUP BY t.id
    HAVING opportunityCount >= 2 OR lastPlanDate < ?
    ORDER BY opportunityCount DESC, lastPlanDate DESC
    LIMIT 12`).all(since, planDate, planDate) as Array<{
    topicId: string;
    title: string;
    opportunityCount: number;
    firstPlanDate: string;
    lastPlanDate: string;
  }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const fingerprint = fingerprintTopic(row.topicId);
    const existing = database.prepare(`SELECT id, state FROM work_carry_items WHERE object_type='topic' AND fingerprint=?`).get(fingerprint) as {
      id: string;
      state: CarryState;
    } | undefined;
    if (existing) {
      if (existing.state === 'done' || existing.state === 'dismissed') continue;
      database.prepare(`UPDATE work_carry_items SET title=?, last_seen_at=?, updated_at=?, revision=revision+1 WHERE id=?`)
        .run(row.title, now, now, existing.id);
      continue;
    }
    const id = randomUUID();
    database.prepare(`INSERT INTO work_carry_items (
        id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json, origin_plan_date,
        first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision
      ) VALUES (?, 'topic', ?, ?, ?, 'watching', NULL, ?, '[]', ?, ?, ?, ?, 1, ?, '[]', ?, ?, 1)`).run(
      id,
      row.topicId,
      fingerprint,
      row.title,
      row.topicId,
      row.firstPlanDate,
      now,
      now,
      addDaysIso(now, DEFAULT_WATCH_DAYS),
      `主题近 ${DEFAULT_ACTIVE_DAYS} 日有 ${row.opportunityCount} 条机会，进入余波观察`,
      now,
      now
    );
  }
}

function refreshAftershocks(database: DatabaseSync, planDate: string): void {
  const rows = listCarryItems(database, { states: ['active', 'watching'], limit: 80, planDate });
  const now = new Date().toISOString();
  for (const item of rows) {
    if (!item.topicId) continue;
    const exclude = item.sourceIds;
    const sql = `SELECT DISTINCT s.id AS sourceId, s.title, s.collected_at AS collectedAt
      FROM source_items s
      JOIN plan_items pi ON pi.topic_id = ?
      JOIN json_each(pi.source_ids_json) j ON j.value = s.id
      WHERE s.collected_at > ?
      ${exclude.length ? `AND s.id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
      ORDER BY s.collected_at DESC
      LIMIT 5`;
    const aftershocks = database.prepare(sql).all(item.topicId, item.firstSeenAt, ...exclude) as AftershockItem[];
    database.prepare(`UPDATE work_carry_items SET aftershock_json=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(aftershocks), now, item.id);
  }
}

function recomputeDecayScores(database: DatabaseSync, planDate: string): void {
  const rows = database.prepare(`SELECT id, state, priority, first_seen_at AS firstSeenAt, origin_plan_date AS originPlanDate, aftershock_json AS aftershocks
    FROM work_carry_items WHERE state IN ('active','watching')`).all() as Array<{
    id: string;
    state: CarryState;
    priority: number | null;
    firstSeenAt: string;
    originPlanDate: string | null;
    aftershocks: string;
  }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const days = Math.max(0, daysBetween(row.originPlanDate || row.firstSeenAt, planDate));
    const base = row.state === 'watching' ? 0.55 : 1;
    const priorityBoost = row.priority == null ? 0 : Math.max(0, (2 - row.priority) * 0.12);
    const aftershockBoost = Math.min(0.3, (JSON.parse(row.aftershocks || '[]') as unknown[]).length * 0.1);
    const decay = Math.max(0.05, base + priorityBoost + aftershockBoost - days * 0.12);
    database.prepare(`UPDATE work_carry_items SET decay_score=?, updated_at=? WHERE id=?`).run(decay, now, row.id);
  }
}

function listPinnedSources(database: DatabaseSync, planDate: string, fermenting: WorkCarryItem[]) {
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

function listCarryItems(database: DatabaseSync, input: { states?: CarryState[]; limit?: number; planDate?: string } = {}): WorkCarryItem[] {
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

function getCarryItem(database: DatabaseSync, id: string, planDate = shanghaiDate()): WorkCarryItem | null {
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

function expireDueCarryItems(database: DatabaseSync): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE work_carry_items
    SET state='expired', updated_at=?, revision=revision+1
    WHERE state IN ('active','watching') AND expires_at < ?`).run(now, now);
}

function promoteCarryWatchingToLibrary(database: DatabaseSync): void {
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

function loadTodayPlanDedup(database: DatabaseSync, planDate: string): TodayPlanDedup {
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

function isCoveredByTodayPlan(item: WorkCarryItem, today: TodayPlanDedup, planDate: string): boolean {
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

function hasProjectForPlanItemOrSources(database: DatabaseSync, planItemId: string, sourceIds: string[]): boolean {
  const byPlan = database.prepare(`SELECT id FROM content_projects WHERE plan_item_id=? AND archived_at IS NULL LIMIT 1`).get(planItemId);
  if (byPlan) return true;
  if (!sourceIds.length) return false;
  const row = database.prepare(`SELECT 1 AS ok FROM content_project_sources cps
    JOIN content_projects cp ON cp.id = cps.project_id
    WHERE cp.archived_at IS NULL AND cps.source_id IN (${sourceIds.map(() => '?').join(',')})
    LIMIT 1`).get(...sourceIds) as { ok: number } | undefined;
  return Boolean(row);
}
function compareCarry(a: WorkCarryItem, b: WorkCarryItem): number {
  const stateRank = (state: CarryState) => (state === 'active' ? 0 : state === 'watching' ? 1 : 2);
  const typeRank = (type: CarryObjectType) => (type === 'plan_item' ? 0 : type === 'source' ? 1 : 2);
  return stateRank(a.state) - stateRank(b.state)
    || typeRank(a.objectType) - typeRank(b.objectType)
    || (a.priority ?? 9) - (b.priority ?? 9)
    || b.decayScore - a.decayScore
    || b.lastSeenAt.localeCompare(a.lastSeenAt);
}

function defaultReason(priority: number, timeliness: string): string {
  if (priority <= 1) return '高优先级机会，默认跨日发酵';
  if (isMultiDayTimeliness(timeliness)) return `时效「${timeliness}」，进入多日跟踪`;
  return '未消化机会，短期续命';
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
}

function toUtcIsoBound(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function addDaysDate(planDate: string, days: number): string {
  const date = new Date(`${planDate}T12:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return shanghaiDate(date);
}

function daysBetween(fromIsoOrDate: string, toPlanDate: string): number {
  const from = fromIsoOrDate.length <= 10
    ? new Date(`${fromIsoOrDate}T12:00:00+08:00`)
    : new Date(fromIsoOrDate);
  const to = new Date(`${toPlanDate}T12:00:00+08:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}
