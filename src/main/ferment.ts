import { broadcastDataChanged } from './data-changed.ts';
import { markSourcesWatching } from './knowledge.ts';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isScoredApproved, sameThesis } from '../shared/propagation.ts';
import {
  addDaysDate,
  addDaysIso,
  bigramJaccard,
  compareCarry,
  daysBetween,
  defaultReason,
  expireDueCarryItems,
  getCarryItem,
  hasProjectForPlanItemOrSources,
  hasWhyWatching,
  isCoveredByTodayPlan,
  listCarryItems,
  listPinnedSources,
  loadTodayPlanDedup,
  normalizeTitle,
  promoteCarryWatchingToLibrary,
  sameStory,
  storyKeyOf,
  titleBigrams,
  toUtcIsoBound
} from './ferment-read.ts';

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
  storyKey: string | null;
  stage: 'emerging' | 'fermenting' | 'cooling' | null;
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

export type TimelinessClass = 'breaking' | 'hot' | 'evergreen';

export const TIMELINESS_WINDOW_HOURS: Record<TimelinessClass, number | null> = {
  breaking: 24,
  hot: 72,
  evergreen: null
};

/**
 * 时效分类：判断 Agent 在四问中输出的 timeliness 文本 → 系统执行过期检查的窗口。
 * 爆点约 24h、热点约 3 天、长青常驻；无法识别时按热点处理。
 */
export function classifyTimeliness(value: string | null | undefined): TimelinessClass {
  if (!value) return 'hot';
  const text = value.toLowerCase();
  if (/长青|常青|长期有效|常驻|系列|教程|方法论|evergreen/.test(text)) return 'evergreen';
  if (/爆点|突发|今日|今天|当天|当日|24\s*小时|小时内|即时|紧急|breaking/.test(text)) return 'breaking';
  return 'hot';
}

/**
 * 否决一个机会：已有 carry 行的走状态机；没有 carry 行（短时效未入池的 plan_item）直接落一条
 * dismissed 指纹行，保证后续方案重播种（upsertCarryFromPlanItem）永远不会复活它。
 */
export function dismissCarryForPlanItem(
  database: DatabaseSync,
  input: { planItemId: string; reason?: string },
  broadcast = false
): WorkCarryItem {
  const item = database.prepare(`SELECT id, title, priority, timeliness, topic_id AS topicId, source_ids_json AS sourceIds
    FROM plan_items WHERE id = ?`).get(input.planItemId) as {
    id: string; title: string; priority: number; timeliness: string | null; topicId: string | null; sourceIds: string;
  } | undefined;
  if (!item) throw new Error('机会不存在。');
  const sourceIds = JSON.parse(item.sourceIds) as string[];
  const fingerprint = fingerprintPlanItem({ title: item.title, topicId: item.topicId, sourceIds });
  const existing = database.prepare(`SELECT id FROM work_carry_items WHERE object_type='plan_item' AND fingerprint=?`).get(fingerprint) as { id: string } | undefined;
  if (existing) {
    const current = getCarryItem(database, existing.id);
    if (!current) throw new Error('续命条目读取失败。');
    if (current.state === 'dismissed') return current;
    return setCarryState(database, { id: existing.id, expectedRevision: current.revision, state: 'dismissed', reason: input.reason }, broadcast);
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`INSERT INTO work_carry_items (
      id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json, origin_plan_date,
      first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision, story_key
    ) VALUES (?, 'plan_item', ?, ?, ?, 'dismissed', ?, ?, ?, NULL, ?, ?, ?, 1, ?, '[]', ?, ?, 1, ?)`).run(
    id,
    item.id,
    fingerprint,
    item.title,
    item.priority,
    item.topicId,
    JSON.stringify(sourceIds),
    now,
    now,
    now,
    input.reason ?? '用户否决',
    now,
    now,
    storyKeyOf({ title: item.title, topicId: item.topicId, sourceIds })
  );
  const created = getCarryItem(database, id);
  if (!created) throw new Error('否决写入后读取失败。');
  if (broadcast) broadcastDataChanged({ scopes: ['today'], reason: 'carry.dismiss' });
  return created;
}
export function refreshWorkCarry(database: DatabaseSync, planDate = shanghaiDate()): FermentingBundle {
  expireDueCarryItems(database);
  promoteCarryWatchingToLibrary(database);
  seedCarryFromRecentPlans(database, planDate);
  seedCarryFromHighValueSources(database, planDate);
  seedCarryFromTopics(database, planDate);
  mergeSimilarCarryItems(database);
  refreshAftershocks(database, planDate);
  backfillCarryStoryKeys(database);
  deriveCarryStages(database);
  recomputeDecayScores(database, planDate);
  return listFermentingBundle(database, planDate);
}

/**
 * 同一故事跨天演化时，模型每天换个措辞、换一组来源子集，字面指纹不同就会各落一条 carry。
 * story 身份：topicId → 来源重合（shared≥2 或 Jaccard≥0.5）→ 规范化标题 bigram。
 * 保留最近出现的一行，其余置 dismissed（不复活语义与指纹泊车一致）。
 */
export function mergeSimilarCarryItems(database: DatabaseSync): number {
  const rows = database.prepare(`SELECT id, title, topic_id AS topicId, source_ids_json AS sourceIds, last_seen_at AS lastSeenAt, revision,
      story_key AS storyKey
    FROM work_carry_items
    WHERE object_type='plan_item' AND state IN ('active','watching')
    ORDER BY last_seen_at DESC`).all() as Array<{
    id: string;
    title: string;
    topicId: string | null;
    sourceIds: string;
    lastSeenAt: string;
    revision: number;
    storyKey: string | null;
  }>;
  if (rows.length < 2) return 0;
  const parsed = rows.map((row) => ({
    ...row,
    sourceIdList: JSON.parse(row.sourceIds || '[]') as string[]
  }));
  const sets = new Map(parsed.map((row) => [row.id, new Set(row.sourceIdList)]));
  const merged: string[] = [];
  const alive = new Set(parsed.map((row) => row.id));
  for (let i = 0; i < parsed.length; i++) {
    const keeper = parsed[i];
    if (!alive.has(keeper.id)) continue;
    const keeperSources = sets.get(keeper.id)!;
    for (let j = i + 1; j < parsed.length; j++) {
      const candidate = parsed[j];
      if (!alive.has(candidate.id)) continue;
      const candidateSources = sets.get(candidate.id)!;
      const match = sameStory(
        { title: keeper.title, topicId: keeper.topicId, sourceIds: [...keeperSources] },
        { title: candidate.title, topicId: candidate.topicId, sourceIds: [...candidateSources] }
      );
      if (!match) continue;
      // 合并行继承 keeper 的故事键（同 story 身份收敛，跨日措辞/来源漂移不再分叉）。
      const unifiedKey = keeper.storyKey ?? candidate.storyKey;
      database.prepare(`UPDATE work_carry_items SET state='dismissed', reason=?, story_key=COALESCE(?, story_key), updated_at=?, revision=revision+1 WHERE id=?`)
        .run(`合并为同一故事：${keeper.title.slice(0, 40)}`, unifiedKey, new Date().toISOString(), candidate.id);
      if (unifiedKey && !keeper.storyKey) {
        database.prepare(`UPDATE work_carry_items SET story_key=?, updated_at=? WHERE id=?`).run(unifiedKey, new Date().toISOString(), keeper.id);
      }
      alive.delete(candidate.id);
      merged.push(candidate.id);
      for (const id of candidateSources) keeperSources.add(id);
    }
  }
  if (merged.length) broadcastDataChanged({ scopes: ['today'], reason: 'carry.merge' });
  return merged.length;
}

export function listFermentingBundle(database: DatabaseSync, planDate = shanghaiDate()): FermentingBundle {
  // M-5001: long-horizon identity = Topic progress only (PRODUCT C4 / SPEC §1.0).
  // plan_item carry remains for proposals state; bare source carry is no longer projected.
  const sourceSinceIso = toUtcIsoBound(`${addDaysDate(planDate, -DEFAULT_ACTIVE_DAYS)}T00:00:00.000+08:00`);
  const watchSinceIso = toUtcIsoBound(`${addDaysDate(planDate, -DEFAULT_WATCH_DAYS)}T00:00:00.000+08:00`);
  const nowIso = new Date().toISOString();

  const rows = database.prepare(`SELECT t.id AS topicId, t.title, t.status, t.first_seen_at AS firstSeenAt,
      t.last_seen_at AS lastSeenAt, t.revision,
      (SELECT count(DISTINCT l.source_id) FROM topic_source_links l WHERE l.topic_id = t.id) AS sourceCount,
      (SELECT count(DISTINCT pi.id) FROM plan_items pi WHERE pi.topic_id = t.id) AS opportunityCount,
      (SELECT min(c.priority) FROM work_carry_items c
        WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state IN ('active','watching')) AS bestPriority,
      (SELECT c.reason FROM work_carry_items c
        WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state IN ('active','watching')
        ORDER BY c.priority ASC, c.last_seen_at DESC LIMIT 1) AS carryReason,
      (SELECT count(*) FROM work_carry_items c
        WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state = 'active') AS activeCarryCount,
      (SELECT count(*) FROM work_carry_items c
        WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state = 'watching') AS watchingCarryCount,
      (SELECT s.title FROM topic_source_links l
        JOIN source_items s ON s.id = l.source_id
        WHERE l.topic_id = t.id
        ORDER BY s.collected_at DESC LIMIT 1) AS latestSourceTitle,
      (SELECT max(s.collected_at) FROM topic_source_links l
        JOIN source_items s ON s.id = l.source_id
        WHERE l.topic_id = t.id AND s.collected_at >= ?) AS latestSourceAt,
      (SELECT max(c.last_seen_at) FROM work_carry_items c
        WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state IN ('active','watching')) AS latestCarryAt,
      (SELECT c.source_ids_json FROM work_carry_items c
        WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state IN ('active','watching')
        ORDER BY c.priority ASC, c.last_seen_at DESC LIMIT 1) AS carrySourceIds
    FROM topics t
    WHERE t.status IN ('active','watching')
      AND (
        EXISTS (
          SELECT 1 FROM work_carry_items c
          WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state IN ('active','watching')
        )
        OR EXISTS (
          SELECT 1 FROM topic_source_links l
          JOIN source_items s ON s.id = l.source_id
          WHERE l.topic_id = t.id AND s.collected_at >= ?
        )
        OR (
          t.last_seen_at >= ?
          AND (
            EXISTS (SELECT 1 FROM topic_source_links l WHERE l.topic_id = t.id)
            OR EXISTS (SELECT 1 FROM plan_items pi WHERE pi.topic_id = t.id)
          )
        )
      )
    ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END,
      COALESCE(
        (SELECT max(c.last_seen_at) FROM work_carry_items c
          WHERE c.topic_id = t.id AND c.object_type = 'plan_item' AND c.state IN ('active','watching')),
        t.last_seen_at
      ) DESC
    LIMIT ?`).all(sourceSinceIso, sourceSinceIso, watchSinceIso, MAX_FERMENTING * 2) as Array<{
    topicId: string;
    title: string;
    status: string;
    firstSeenAt: string;
    lastSeenAt: string;
    revision: number;
    sourceCount: number;
    opportunityCount: number;
    bestPriority: number | null;
    carryReason: string | null;
    activeCarryCount: number;
    watchingCarryCount: number;
    latestSourceTitle: string | null;
    latestSourceAt: string | null;
    latestCarryAt: string | null;
    carrySourceIds: string | null;
  }>;

  const qualifiedRows = rows.filter((row) => isTopicQualifiedForFermenting(database, row.topicId));

  const projectedRaw = qualifiedRows.map((row) => {
    const activeCarry = Number(row.activeCarryCount || 0);
    const watchingCarry = Number(row.watchingCarryCount || 0);
    const sourceCount = Number(row.sourceCount || 0);
    const opportunityCount = Number(row.opportunityCount || 0);
    const recentSource = Boolean(row.latestSourceAt);
    let reason = row.carryReason?.trim() || '';
    if (!reason) {
      if (recentSource) reason = '主题有新资料进展';
      else if (activeCarry + watchingCarry > 0) reason = '主题下仍有未完结选题';
      else if (opportunityCount > 0) reason = '主题仍有历史选题可跟';
      else if (sourceCount > 0) reason = '主题资料库仍在观察';
      else reason = '主题持续关注';
    }
    const aftershocks: AftershockItem[] = row.latestSourceTitle
      ? [{ sourceId: '', title: row.latestSourceTitle, collectedAt: row.latestSourceAt || row.lastSeenAt }]
      : [];
    let sourceIds: string[] = [];
    try {
      sourceIds = row.carrySourceIds ? JSON.parse(row.carrySourceIds) as string[] : [];
    } catch {
      sourceIds = [];
    }
    const state: CarryState = row.status === 'watching' || (activeCarry === 0 && watchingCarry > 0)
      ? 'watching'
      : 'active';
    const lastSeenAt = row.latestCarryAt || row.latestSourceAt || row.lastSeenAt || nowIso;
    const item: WorkCarryItem = {
      id: `topic:${row.topicId}`,
      objectType: 'topic',
      objectId: row.topicId,
      fingerprint: fingerprintTopic(row.topicId),
      title: row.title,
      state,
      priority: row.bestPriority == null ? null : Number(row.bestPriority),
      topicId: row.topicId,
      sourceIds,
      originPlanDate: null,
      firstSeenAt: row.firstSeenAt || lastSeenAt,
      lastSeenAt,
      expiresAt: addDaysIso(lastSeenAt, DEFAULT_WATCH_DAYS),
      decayScore: 1,
      reason,
      aftershocks,
      fermentedDays: daysBetween(row.firstSeenAt || lastSeenAt, planDate),
      createdAt: row.firstSeenAt || lastSeenAt,
      updatedAt: lastSeenAt,
      revision: Number(row.revision || 1),
      storyKey: `topic:${row.topicId}`,
      stage: state === 'watching' ? 'cooling' : 'fermenting'
    };
    return item;
  });

  const projected = dedupeThesisForFermenting(database, projectedRaw);

  const items = projected.filter((item) => item.state === 'active').slice(0, MAX_FERMENTING);
  const watchingItems = projected.filter((item) => item.state === 'watching').slice(0, MAX_FERMENTING);
  const topicSummary = projected.slice(0, 8).map((item) => ({
    topicId: item.topicId || item.objectId,
    title: item.title,
    activeCount: item.state === 'active' ? 1 : 0,
    watchingCount: item.state === 'watching' ? 1 : 0,
    latestTitle: item.aftershocks[0]?.title ?? null,
    fermentedDays: item.fermentedDays
  }));

  return {
    items,
    watchingItems,
    topics: topicSummary,
    pinnedSources: []
  };
}

function isTopicQualifiedForFermenting(database: DatabaseSync, topicId: string): boolean {
  const planRows = database.prepare(`SELECT planning_status, score_reasons_json, point_of_view, planning_provenance_json FROM plan_items WHERE topic_id = ?`).all(topicId) as Array<{ planning_status: string; score_reasons_json: string; point_of_view: string; planning_provenance_json: string }>;
  if (planRows.length === 0) {
    const hasLink = database.prepare(`SELECT 1 FROM topic_source_links WHERE topic_id = ? LIMIT 1`).get(topicId);
    return Boolean(hasLink);
  }
  for (const row of planRows) {
    if (isScoredApproved(row)) return true;
  }
  return false;
}

function dedupeThesisForFermenting(database: DatabaseSync, items: WorkCarryItem[]): WorkCarryItem[] {
  if (items.length <= 1) return items;
  const thesisByTopic = new Map<string, { pointOfView: string; angle: string; targetAudience: string }>();
  for (const item of items) {
    const topicId = item.topicId ?? item.objectId;
    const row = database.prepare(`SELECT point_of_view AS pov, angle, target_audience AS audience FROM plan_items WHERE topic_id = ? AND planning_status='approved' ORDER BY created_at DESC LIMIT 1`).get(topicId) as { pov: string; angle: string; audience: string } | undefined;
    if (row) thesisByTopic.set(item.id, { pointOfView: row.pov ?? '', angle: row.angle ?? '', targetAudience: row.audience ?? '' });
    else thesisByTopic.set(item.id, { pointOfView: item.title, angle: '', targetAudience: '' });
  }
  const kept: WorkCarryItem[] = [];
  for (const cur of items) {
    const curThesis = thesisByTopic.get(cur.id)!;
    let dup = false;
    for (const keeper of kept) {
      const keepThesis = thesisByTopic.get(keeper.id)!;
      if (sameThesis(curThesis, keepThesis)) { dup = true; break; }
    }
    if (!dup) kept.push(cur);
  }
  return kept;
}

export function setCarryState(
  database: DatabaseSync,
  input: { id: string; expectedRevision: number; state: CarryState; reason?: string },
  broadcast = true
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
  if (broadcast) broadcastDataChanged({ scopes: ['today'], reason: 'carry.state' });
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

export function ensureApprovedPlanItemCarryDone(
  database: DatabaseSync,
  input: {
    planItemId: string;
    title: string;
    priority: number;
    topicId?: string | null;
    sourceIds: string[];
    originPlanDate: string;
  }
): { id: string; state: 'done'; revision: number; created: boolean; completed: boolean } {
  const exact = database.prepare(`SELECT id, state, revision FROM work_carry_items
    WHERE object_type='plan_item' AND object_id=? ORDER BY created_at`).all(input.planItemId) as Array<{ id: string; state: CarryState; revision: number }>;
  if (exact.length > 1) throw Object.assign(new Error('multiple carry items point at the approved plan item'), { code: 'AMBIGUOUS_CARRIES' });
  const now = new Date().toISOString();
  const fingerprint = fingerprintPlanItem(input);
  if (exact.length === 1) {
    const current = exact[0];
    if (current.state === 'done') return { id: current.id, state: 'done', revision: current.revision, created: false, completed: false };
    database.prepare(`UPDATE work_carry_items SET state='done', reason=?, updated_at=?, revision=revision+1 WHERE id=?`)
      .run('历史批准链已修复并完成', now, current.id);
    return { id: current.id, state: 'done', revision: current.revision + 1, created: false, completed: true };
  }

  const shared = database.prepare(`SELECT id, state, revision FROM work_carry_items
    WHERE object_type='plan_item' AND fingerprint=?`).get(fingerprint) as { id: string; state: CarryState; revision: number } | undefined;
  if (shared) {
    if (shared.state === 'done') return { id: shared.id, state: 'done', revision: shared.revision, created: false, completed: false };
    database.prepare(`UPDATE work_carry_items SET state='done', reason=?, updated_at=?, revision=revision+1 WHERE id=?`)
      .run('历史批准链已修复并完成', now, shared.id);
    return { id: shared.id, state: 'done', revision: shared.revision + 1, created: false, completed: true };
  }
  const id = randomUUID();
  database.prepare(`INSERT INTO work_carry_items (
      id, object_type, object_id, fingerprint, title, state, priority, topic_id, source_ids_json, origin_plan_date,
      first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision, story_key
    ) VALUES (?, 'plan_item', ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', ?, ?, 1, ?)`).run(
    id,
    input.planItemId,
    fingerprint,
    input.title,
    input.priority,
    input.topicId ?? null,
    JSON.stringify(input.sourceIds),
    input.originPlanDate,
    now,
    now,
    now,
    '历史批准链已修复并完成',
    now,
    now,
    storyKeyOf({ title: input.title, topicId: input.topicId ?? null, sourceIds: input.sourceIds })
  );
  return { id, state: 'done', revision: 1, created: true, completed: false };
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
  const storyKey = storyKeyOf({ title: input.title, topicId: input.topicId ?? null, sourceIds: input.sourceIds });
  const now = new Date().toISOString();
  const existing = database.prepare(`SELECT id FROM work_carry_items WHERE object_type='plan_item' AND fingerprint=?`).get(fingerprint) as { id: string } | undefined;
  if (existing) {
    const current = getCarryItem(database, existing.id, input.originPlanDate);
    if (!current) return null;
    // Respect user parking: never auto-revive watching/done/dismissed from reseeding.
    if (current.state === 'done' || current.state === 'dismissed' || current.state === 'watching') return current;
    database.prepare(`UPDATE work_carry_items SET
      object_id=?, title=?, priority=?, topic_id=?, source_ids_json=?, origin_plan_date=COALESCE(origin_plan_date, ?),
      last_seen_at=?, expires_at=?, story_key=COALESCE(?, story_key), reason=COALESCE(reason, ?), updated_at=?, revision=revision+1
      WHERE id=?`).run(
      input.planItemId,
      input.title,
      input.priority,
      input.topicId ?? null,
      JSON.stringify(input.sourceIds),
      input.originPlanDate,
      now,
      addDaysIso(now, DEFAULT_ACTIVE_DAYS),
      storyKey,
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
      first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision, story_key
    ) VALUES (?, 'plan_item', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]', ?, ?, 1, ?)`).run(
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
    now,
    storyKey
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

function seedCarryFromHighValueSources(_database: DatabaseSync, _planDate: string): void {
  // M-5001 / PRODUCT C4: bare high-value sources must not be promoted onto the continuous-attention desk.
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
        first_seen_at, last_seen_at, expires_at, decay_score, reason, aftershock_json, created_at, updated_at, revision, story_key
      ) VALUES (?, 'topic', ?, ?, ?, 'watching', NULL, ?, '[]', ?, ?, ?, ?, 1, ?, '[]', ?, ?, 1, ?)`).run(
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
      now,
      `topic:${row.topicId}`
    );
  }
}

/**
 * 余波计算：同一故事在 firstSeenAt 之后出现的新来源/新进展。
 * 完整版去 topic 硬依赖：
 * - 有 topicId：沿用既有路径——被同主题 plan_items 引用的新来源（语义强信号）。
 * - 无 topicId：按 storyKey 判定——(a) 被「同故事」plan_item（来源重合/标题 bigram 命中）引用的新来源；
 *   (b) 直接与 carry 标题做规范化 bigram 重合的新来源（尚未进任何方案也会点亮后续）。
 * 候选集单次查询供全部 carry 行复用；窗口 = 行内最早 firstSeenAt（下限 now-14d，active 最长 7 天存活）。
 */
function refreshAftershocks(database: DatabaseSync, planDate: string): void {
  const rows = listCarryItems(database, { states: ['active', 'watching'], limit: 80, planDate });
  if (!rows.length) return;
  const now = new Date().toISOString();
  const lowerBound = addDaysIso(now, -DEFAULT_WATCH_DAYS);
  const windowStart = rows.reduce((min, item) => (item.firstSeenAt < min ? item.firstSeenAt : min), lowerBound);

  const candidates = database.prepare(`SELECT s.id AS sourceId, s.title, s.collected_at AS collectedAt
    FROM source_items s
    WHERE s.collected_at >= ? AND s.management_status != 'archived'
    ORDER BY s.collected_at DESC
    LIMIT 500`).all(windowStart) as AftershockItem[];

  // 最近 plan_items 的来源归属索引：topic 路径 + 无 topic 的来源重合路径都靠它判断故事身份。
  const planRows = database.prepare(`SELECT pi.title, pi.topic_id AS topicId, pi.source_ids_json AS sourceIds
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE p.is_current = 1 AND pi.created_at >= ?
    LIMIT 400`).all(windowStart) as Array<{ title: string; topicId: string | null; sourceIds: string }>;
  const plansBySource = new Map<string, Array<{ title: string; topicId: string | null; sourceIds: string[] }>>();
  for (const row of planRows) {
    const sourceIds = JSON.parse(row.sourceIds || '[]') as string[];
    const ref = { title: row.title, topicId: row.topicId, sourceIds };
    for (const id of sourceIds) {
      const list = plansBySource.get(id);
      if (list) list.push(ref);
      else plansBySource.set(id, [ref]);
    }
  }

  for (const item of rows) {
    const exclude = new Set(item.sourceIds);
    const seen = new Set<string>();
    const aftershocks: AftershockItem[] = [];
    const add = (candidate: AftershockItem): void => {
      if (exclude.has(candidate.sourceId) || seen.has(candidate.sourceId)) return;
      seen.add(candidate.sourceId);
      aftershocks.push(candidate);
    };
    for (const candidate of candidates) {
      if (candidate.collectedAt <= item.firstSeenAt) continue;
      const refs = plansBySource.get(candidate.sourceId);
      if (item.topicId) {
        if (refs?.some((ref) => ref.topicId === item.topicId)) add(candidate);
        continue;
      }
      // 无 topic：先按同故事 plan_item 引用命中（来源重合或标题 bigram），再直接标题重合。
      if (refs?.some((ref) => sameStory(
        { title: item.title, topicId: null, sourceIds: item.sourceIds },
        { title: ref.title, topicId: ref.topicId, sourceIds: ref.sourceIds }
      ))) {
        add(candidate);
        continue;
      }
      if (bigramJaccard(titleBigrams(item.title), titleBigrams(candidate.title)) >= 0.5) add(candidate);
    }
    aftershocks.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
    database.prepare(`UPDATE work_carry_items SET aftershock_json=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(aftershocks.slice(0, 5)), now, item.id);
  }
}

/** 为活跃行补齐 story_key（旧行/直写行迁移后首刷回填；insert 路径已写入）。 */
function backfillCarryStoryKeys(database: DatabaseSync): void {
  const rows = database.prepare(`SELECT id, title, topic_id AS topicId, source_ids_json AS sourceIds
    FROM work_carry_items
    WHERE story_key IS NULL AND state IN ('active','watching')`).all() as Array<{
    id: string;
    title: string;
    topicId: string | null;
    sourceIds: string;
  }>;
  if (!rows.length) return;
  const now = new Date().toISOString();
  for (const row of rows) {
    const key = storyKeyOf({ title: row.title, topicId: row.topicId, sourceIds: JSON.parse(row.sourceIds || '[]') as string[] });
    if (!key) continue;
    database.prepare(`UPDATE work_carry_items SET story_key=?, updated_at=? WHERE id=?`).run(key, now, row.id);
  }
}

/**
 * 派生阶段（完整版 stage 列固化）：watching → cooling；active 有「为何关注」信号（余波或未完结语义）
 * → fermenting（进持续关注 rail）；active 无信号 → emerging（待处理/观察折叠）。
 * 幂等：stage 不变不写。
 */
function deriveCarryStages(database: DatabaseSync): void {
  const rows = database.prepare(`SELECT id, state, aftershock_json AS aftershocks, reason FROM work_carry_items
    WHERE state IN ('active','watching')`).all() as Array<{
    id: string;
    state: CarryState;
    aftershocks: string;
    reason: string | null;
  }>;
  if (!rows.length) return;
  const now = new Date().toISOString();
  for (const row of rows) {
    const aftershockCount = (JSON.parse(row.aftershocks || '[]') as unknown[]).length;
    const stage: NonNullable<WorkCarryItem['stage']> = row.state === 'watching'
      ? 'cooling'
      : (aftershockCount > 0 || hasWhyWatching({ aftershocks: [], reason: row.reason }))
        ? 'fermenting'
        : 'emerging';
    database.prepare(`UPDATE work_carry_items SET stage=?, updated_at=? WHERE id=? AND (stage IS NULL OR stage<>?)`)
      .run(stage, now, row.id, stage);
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
