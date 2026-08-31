import { DatabaseSync } from 'node:sqlite';
import { classifyTimeliness, fingerprintPlanItem, listFermentingBundle, shanghaiDate, TIMELINESS_WINDOW_HOURS, type FermentingBundle, type TimelinessClass } from './ferment.ts';
import { addDaysDate, hasProjectForPlanItemOrSources, sameStory, toUtcIsoBound } from './ferment-read.ts';
import { listXPostTrends, type XPostTrend } from './x-post-metrics.ts';
import { buildTodayRecommendationProjection, type TodayRecommendationProjection } from './today-recommendation.ts';
import { readManagerAdapterProjection, type ManagerAdapterProjection, type ManagerAdapterReadModel } from './workspace-orchestrator-manager-adapter.ts';
export type TodaySource = {
  id: string;
  title: string;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  summary: string | null;
  priority: number | null;
  categories: string[];
  valueJudgment: string | null;
  /** X/社区作者头像；无则 UI 回落到平台/文档标。 */
  avatarUrl: string | null;
};

export type TodayPlanItem = {
  id: string;
  topicId: string | null;
  title: string;
  priority: number;
  whyNow: string;
  timeliness: string;
  targetAudience: string;
  angle: string;
  pointOfView: string;
  platforms: string[];
  formats: string[];
  titleGuidance: string;
  openingGuidance: string;
  structureGuidance: string;
  effortEstimate: string;
  sourceIds: string[];
  availableMaterials: string[];
  missingMaterials: string[];
  trendEvidence: XPostTrend[];
  planningStatus?: string | null;
  revision?: number | null;
  planningProvenanceJson?: string | null;
  scoreReasonsJson?: string | null;
};
type SourceRow = Omit<TodaySource, 'categories' | 'avatarUrl'> & { categories: string; evidence: string | null };
type TodayPlan = { id: string; planDate: string; summary: string; items: TodayPlanItem[] };

/** Lightweight same-day task snapshot for Today truthful projection (renderer-owned). */
export type TodayRunTaskSnapshot = {
  id?: string;
  status?: string;
  phase?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  progress?: Record<string, unknown> | null;
  events?: Array<{ message?: string }>;
  createdAt?: string;
  updatedAt?: string;
  heartbeatAt?: string;
  checkpoint?: Record<string, unknown> | null;
  emptyQualified?: boolean;
};

function readEvidenceAvatar(evidence: string | null | undefined): string | null {
  if (!evidence) return null;
  try {
    const parsed = JSON.parse(evidence) as { avatarUrl?: unknown };
    return typeof parsed.avatarUrl === 'string' && /^https?:\/\//i.test(parsed.avatarUrl) ? parsed.avatarUrl : null;
  } catch {
    return null;
  }
}

function buildXAvatarIndex(database: DatabaseSync): Map<string, string> {
  const index = new Map<string, string>();
  const rows = database.prepare('SELECT payload_json AS payloadJson FROM x_list_timeline_cache').all() as Array<{ payloadJson: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payloadJson) as { posts?: Array<{ url?: unknown; avatarUrl?: unknown }> };
      for (const post of payload.posts ?? []) {
        const url = typeof post.url === 'string' ? post.url : '';
        const avatarUrl = typeof post.avatarUrl === 'string' && /^https?:\/\//i.test(post.avatarUrl) ? post.avatarUrl : '';
        if (!url || !avatarUrl) continue;
        index.set(url, avatarUrl);
        const statusId = url.match(/status\/(\d+)/i)?.[1];
        if (statusId) index.set(statusId, avatarUrl);
      }
    } catch {
      // ignore malformed cache rows
    }
  }
  return index;
}

function resolveSourceAvatar(source: { canonicalUrl: string | null; evidence: string | null }, avatarIndex: Map<string, string>): string | null {
  const fromEvidence = readEvidenceAvatar(source.evidence);
  if (fromEvidence) return fromEvidence;
  const url = source.canonicalUrl || '';
  if (!url) return null;
  return avatarIndex.get(url) ?? (url.match(/status\/(\d+)/i)?.[1] ? avatarIndex.get(url.match(/status\/(\d+)/i)![1]) ?? null : null);
}

function mapSourceRows(rows: SourceRow[], avatarIndex: Map<string, string>): TodaySource[] {
  return rows.map((source) => {
    const { evidence, categories, ...rest } = source;
    return {
      ...rest,
      categories: JSON.parse(categories) as string[],
      avatarUrl: resolveSourceAvatar({ canonicalUrl: source.canonicalUrl, evidence }, avatarIndex)
    };
  });
}

function loadPlanItems(database: DatabaseSync, planId: string): TodayPlanItem[] {
  const rows = database.prepare(`SELECT id, topic_id AS topicId, title, priority, why_now AS whyNow, timeliness,
    target_audience AS targetAudience, angle, point_of_view AS pointOfView, platforms_json AS platforms,
    formats_json AS formats, title_guidance AS titleGuidance, opening_guidance AS openingGuidance,
    structure_guidance AS structureGuidance, effort_estimate AS effortEstimate, source_ids_json AS sourceIds,
    available_materials_json AS availableMaterials, missing_materials_json AS missingMaterials,
    planning_status AS planningStatus, revision, planning_provenance_json AS planningProvenanceJson, score_reasons_json AS scoreReasonsJson
    FROM plan_items WHERE plan_id = ? ORDER BY priority ASC, sort_order ASC`).all(planId) as Array<Omit<TodayPlanItem, 'platforms' | 'formats' | 'sourceIds' | 'availableMaterials' | 'missingMaterials' | 'trendEvidence'> & { platforms: string; formats: string; sourceIds: string; availableMaterials: string; missingMaterials: string }>;
  return rows.map((item) => {
    const sourceIds = JSON.parse(item.sourceIds) as string[];
    return {
      ...item,
      platforms: JSON.parse(item.platforms) as string[],
      formats: JSON.parse(item.formats) as string[],
      sourceIds,
      availableMaterials: JSON.parse(item.availableMaterials) as string[],
      missingMaterials: JSON.parse(item.missingMaterials) as string[],
      trendEvidence: listXPostTrends(database, { sourceIds })
    };
  });
}

function loadPlan(database: DatabaseSync, planDate?: string): TodayPlan | null {
  const plan = (planDate
    ? database.prepare('SELECT id, plan_date AS planDate, summary FROM plans WHERE plan_date = ? AND is_current = 1').get(planDate)
    : database.prepare('SELECT id, plan_date AS planDate, summary FROM plans WHERE is_current = 1 ORDER BY plan_date DESC LIMIT 1').get()
  ) as { id: string; planDate: string; summary: string } | undefined;
  if (!plan) return null;
  return { ...plan, items: loadPlanItems(database, plan.id) };
}

/** 最近一份「有可批 items」的方案（可含同日被空 current 降级的旧 plan）。运行记录层的空 current 不参与主席兜底。 */
function loadLatestNonEmptyPlan(database: DatabaseSync, options: { excludePlanId?: string | null } = {}): TodayPlan | null {
  const plan = (options.excludePlanId
    ? database.prepare(`SELECT id, plan_date AS planDate, summary FROM plans p
        WHERE p.id != ? AND EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = p.id)
        ORDER BY p.plan_date DESC, p.created_at DESC LIMIT 1`).get(options.excludePlanId)
    : database.prepare(`SELECT id, plan_date AS planDate, summary FROM plans p
        WHERE EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = p.id)
        ORDER BY p.plan_date DESC, p.created_at DESC LIMIT 1`).get()
  ) as { id: string; planDate: string; summary: string } | undefined;
  if (!plan) return null;
  return { ...plan, items: loadPlanItems(database, plan.id) };
}

export function getTodayPlanExhaustion(database: DatabaseSync, planDate: string): { total: number; unresolved: number; rejected: number; isExhausted: boolean; hasPlan: boolean } {
  const plan = loadPlan(database, planDate);
  if (!plan || !plan.items.length) return { total: 0, unresolved: 0, rejected: 0, isExhausted: false, hasPlan: false };
  let unresolved = 0;
  let rejected = 0;
  const carryByObject = database.prepare(`SELECT state FROM work_carry_items WHERE object_type='plan_item' AND object_id = ?`);
  const carryByFp = database.prepare(`SELECT state FROM work_carry_items WHERE fingerprint = ?`);
  for (const item of plan.items) {
    const status = item.planningStatus ?? null;
    const isPlanningRejected = status === 'rejected';
    let isCarryDismissed = false;
    try {
      const byObject = carryByObject.get(item.id) as { state: string } | undefined;
      if (byObject?.state === 'dismissed') isCarryDismissed = true;
      else {
        const fp = fingerprintPlanItem({ title: item.title, topicId: item.topicId, sourceIds: item.sourceIds ?? [] });
        const byFp = carryByFp.get(fp) as { state: string } | undefined;
        if (byFp?.state === 'dismissed') isCarryDismissed = true;
      }
    } catch {}
    const isRejectedEffective = isPlanningRejected || isCarryDismissed;
    if (isRejectedEffective) rejected += 1;
    else if (status === 'draft' || status === 'ready_for_review') unresolved += 1;
  }
  const isExhausted = plan.items.length > 0 && unresolved === 0 && rejected === plan.items.length;
  return { total: plan.items.length, unresolved, rejected, isExhausted, hasPlan: true };
}
function collectSameDayTasks(database: DatabaseSync, planDate: string): TodayRunTaskSnapshot[] {
  try {
    const rows = database.prepare(`
      SELECT id, status, phase, error_code AS errorCode, error_message AS errorMessage,
             progress_json AS progressJson, events_json AS eventsJson,
             checkpoint_json AS checkpointJson,
             created_at AS createdAt, updated_at AS updatedAt, heartbeat_at AS heartbeatAt
      FROM agent_tasks
      WHERE business_date = ? AND intent IN ('daily_intelligence','daily_scan','daily_judge','page_agents')
      ORDER BY updated_at DESC
      LIMIT 12
    `).all(planDate) as Array<{
      id: string; status: string; phase: string; errorCode: string | null; errorMessage: string | null;
      progressJson: string | null; eventsJson: string | null; checkpointJson: string | null;
      createdAt: string; updatedAt: string; heartbeatAt: string | null;
    }>;
    return rows.map((row) => {
      let progress: Record<string, unknown> | null = null;
      let events: Array<{ message?: string }> | null = null;
      let checkpoint: Record<string, unknown> | null = null;
      let emptyQualified = false;
      try { progress = row.progressJson ? JSON.parse(row.progressJson) as Record<string, unknown> : null; } catch { progress = null; }
      try { events = row.eventsJson ? JSON.parse(row.eventsJson) as Array<{ message?: string }> : null; } catch { events = null; }
      try {
        if (row.checkpointJson) {
          checkpoint = JSON.parse(row.checkpointJson) as Record<string, unknown>;
          const flag = checkpoint.emptyQualified === true || checkpoint.dailyEmptyQualified === true || (checkpoint as Record<string, unknown>).qualifiedEmpty === true;
          emptyQualified = Boolean(flag);
        }
      } catch { checkpoint = null; }
      let errorMessage = row.errorMessage;
      if (!errorMessage && checkpoint && typeof checkpoint.summary === 'string' && String(checkpoint.summary).trim()) {
        errorMessage = String(checkpoint.summary).trim();
      }
      return {
        id: row.id,
        status: row.status,
        phase: row.phase,
        errorCode: row.errorCode,
        errorMessage,
        progress,
        events: events ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        heartbeatAt: row.heartbeatAt ?? undefined,
        checkpoint,
        emptyQualified,
      };
    });
  } catch {
    return [];
  }
}

function parseJsonStrings(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function loadAuthoritativeOpportunityItems(
  database: DatabaseSync,
  ids: readonly string[],
  asOf: Date
): Map<string, OpportunityPoolItem> {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = database.prepare(`SELECT pi.id AS planItemId, p.plan_date AS planDate, pi.title, pi.priority,
      pi.timeliness, pi.topic_id AS topicId, pi.source_ids_json AS sourceIds, pi.why_now AS whyNow,
      pi.angle, pi.point_of_view AS pointOfView, pi.target_audience AS targetAudience,
      pi.platforms_json AS platforms, pi.formats_json AS formats, pi.title_guidance AS titleGuidance,
      pi.opening_guidance AS openingGuidance, pi.structure_guidance AS structureGuidance,
      pi.effort_estimate AS effortEstimate, pi.available_materials_json AS availableMaterials,
      pi.missing_materials_json AS missingMaterials, pi.created_at AS createdAt,
      pi.planning_status AS planningStatus, pi.revision, pi.planning_provenance_json AS planningProvenanceJson,
      pi.score_reasons_json AS scoreReasonsJson
    FROM plan_items pi JOIN plans p ON p.id = pi.plan_id
    WHERE pi.id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
  const carryByItem = database.prepare("SELECT id,state,revision FROM work_carry_items WHERE object_type='plan_item' AND object_id=? ORDER BY updated_at DESC LIMIT 1");
  const result = new Map<string, OpportunityPoolItem>();
  for (const row of rows) {
    const planItemId = String(row.planItemId ?? '');
    if (!planItemId) continue;
    const sourceIds = parseJsonStrings(row.sourceIds);
    const createdAt = String(row.createdAt ?? '');
    const createdMs = Date.parse(createdAt);
    const timeliness = row.timeliness === null || row.timeliness === undefined ? null : String(row.timeliness);
    const timelinessClass = classifyTimeliness(timeliness);
    const windowHours = TIMELINESS_WINDOW_HOURS[timelinessClass];
    const expiresAt = Number.isFinite(createdMs) && windowHours !== null ? new Date(createdMs + windowHours * 3_600_000).toISOString() : null;
    const carryRow = carryByItem.get(planItemId) as { id: string; state: string; revision: number } | undefined;
    result.set(planItemId, {
      planItemId,
      planDate: String(row.planDate ?? ''),
      title: String(row.title ?? ''),
      priority: Number(row.priority ?? 0),
      timeliness,
      timelinessClass,
      expiresAt,
      topicId: row.topicId === null || row.topicId === undefined ? null : String(row.topicId),
      sourceIds,
      whyNow: String(row.whyNow ?? ''),
      angle: String(row.angle ?? ''),
      pointOfView: String(row.pointOfView ?? ''),
      targetAudience: String(row.targetAudience ?? ''),
      platforms: parseJsonStrings(row.platforms),
      formats: parseJsonStrings(row.formats),
      titleGuidance: String(row.titleGuidance ?? ''),
      openingGuidance: String(row.openingGuidance ?? ''),
      structureGuidance: String(row.structureGuidance ?? ''),
      effortEstimate: String(row.effortEstimate ?? ''),
      availableMaterials: parseJsonStrings(row.availableMaterials),
      missingMaterials: parseJsonStrings(row.missingMaterials),
      trendEvidence: listXPostTrends(database, { sourceIds }),
      createdAt,
      isNew: Number.isFinite(createdMs) && createdMs >= asOf.getTime() - 6 * 3_600_000,
      planningStatus: row.planningStatus === null || row.planningStatus === undefined ? null : String(row.planningStatus),
      revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
      planningProvenanceJson: row.planningProvenanceJson === null || row.planningProvenanceJson === undefined ? null : String(row.planningProvenanceJson),
      scoreReasonsJson: row.scoreReasonsJson === null || row.scoreReasonsJson === undefined ? null : String(row.scoreReasonsJson),
      carry: carryRow ? { id: carryRow.id, state: carryRow.state, revision: carryRow.revision } : null,
      demotion: null
    });
  }
  return result;
}

function buildOrchestratorRecommendation(
  database: DatabaseSync,
  legacy: TodayRecommendationProjection,
  roots: readonly ManagerAdapterProjection[],
  businessDate: string,
  asOf: Date
): TodayRecommendationProjection {
  const frozen = roots.filter((root) => root.projectionState === 'frozen' && !root.projectionError);
  const ids: string[] = [];
  for (const root of frozen) for (const id of root.eligiblePlanItemIds) if (!ids.includes(id)) ids.push(id);
  const byId = new Map(legacy.eligible.map((item) => [item.planItemId, item]));
  for (const [id, item] of loadAuthoritativeOpportunityItems(database, ids, asOf)) if (!byId.has(id)) byId.set(id, item);
  const eligible = ids.map((id) => byId.get(id)).filter((item): item is OpportunityPoolItem => Boolean(item));
  const pending = frozen.reduce((count, root) => count + root.pendingPlanItemIds.length, 0);
  const invalid = frozen.reduce((count, root) => count + root.invalidPlanItemIds.length, 0);
  const repairable: TodayRecommendationProjection['repairable'] = [
    ...frozen.flatMap((root) => root.pendingPlanItemIds.map((planItemId) => ({
      planItemId,
      revision: byId.get(planItemId)?.revision ?? 1,
      reasonCode: 'score_pending' as const,
      reason: '编排 Projection 仍在等待评分'
    }))),
    ...frozen.flatMap((root) => root.invalidPlanItemIds.map((planItemId) => ({
      planItemId,
      revision: byId.get(planItemId)?.revision ?? 1,
      reasonCode: 'score_invalid' as const,
      reason: '编排 Projection 标记为 invalid，需修复'
    })))
  ];
  const emptyQualified = frozen.length > 0 && frozen.every((root) => root.emptyQualified && root.eligiblePlanItemIds.length === 0);
  const hasError = roots.some((root) => root.projectionError);
  const emptyReason: TodayRecommendationProjection['emptyReason'] = pending > 0
    ? 'scoring_incomplete'
    : invalid > 0 || hasError ? 'invalid_needs_repair'
      : ids.length > 0 ? 'has_recommendation'
        : emptyQualified ? 'clean_empty' : 'run_active';
  return {
    ...legacy,
    primary: eligible[0] ?? null,
    eligible,
    counts: {
      todayReady: ids.filter((id) => byId.get(id)?.planDate === businessDate).length,
      carriedReady: ids.filter((id) => byId.get(id)?.planDate !== businessDate).length,
      scoringPending: pending,
      invalid
    },
    repairable,
    context: { businessDate, asOf: asOf.toISOString() },
    emptyReason
  };
}

function authoritativeOpportunityCount(database: DatabaseSync, businessDate: string, now: Date): number | null {
  const model = readManagerAdapterProjection(database, { businessDate });
  if (!model.roots.length) return null;
  const ids: string[] = [];
  for (const root of model.roots) {
    if (root.projectionState !== 'frozen' || root.projectionError) continue;
    for (const id of root.eligiblePlanItemIds) if (!ids.includes(id)) ids.push(id);
  }
  void now;
  return ids.length;
}

function getOpportunityCountForDate(database: DatabaseSync, businessDate: string, now: Date): number {
  const authoritative = authoritativeOpportunityCount(database, businessDate, now);
  if (authoritative !== null) return authoritative;
  const projection = buildTodayRecommendationProjection(database, businessDate, { now });
  return projection.eligible.length;
}


export function getToday(database: DatabaseSync, planDate: string, options: { now?: Date } = {}): {
  sources: TodaySource[];
  sourcesTotal: number;
  sourcesDate: string | null;
  plan: TodayPlan | null;
  latestPlan: TodayPlan | null;
  pool: OpportunityPoolItem[];
  recommendation: TodayRecommendationProjection;
  /** All durable orchestrator roots for this workspace/date; never reduced to a latest root. */
  orchestrator: ManagerAdapterReadModel;
  pendingActions: string[];
  topicMaintenance: { pending: number };
  fermenting: FermentingBundle;
  /** 有效资料库口径：当日已移出（archived）条数，供 feed 行尾「另有 N 条与本赛道无关」计数。 */
  archivedTodayCount: number;
  /** Same-day manager/judge tasks for truthful Today projection (partial/failed over unqualified empty succeeded). */
  sameDayTasks: TodayRunTaskSnapshot[];
  /** Derived exhaustion for Today CTA: uses planning_status + work_carry dismissed */
  exhaustion: { total: number; unresolved: number; rejected: number; isExhausted: boolean; hasPlan: boolean };
} {

  // Freshness rail: prefer sources collected on the plan date.
  // Fermenting rail (cross-day) is separate and returned as fermenting.*.
  // 有效资料库口径：今日统计/列表只数未移出（archived）资料；已移出条目以 archivedTodayCount 计数呈现。
  // collected_at 存 UTC Z；日界按上海日历转成 ISO，避免 '+08:00' 与 'Z' 字典序错位导致今日 feed 全空。
  const dayStart = toUtcIsoBound(`${planDate}T00:00:00.000+08:00`);
  const dayEnd = toUtcIsoBound(`${planDate}T23:59:59.999+08:00`);
  const effectiveFilter = "management_status != 'archived'";
  const sourceSelect = `SELECT id, title, canonical_url AS canonicalUrl, author, published_at AS publishedAt,
    collected_at AS collectedAt, summary, priority, categories_json AS categories, value_judgment AS valueJudgment,
    evidence
    FROM source_items`;
  const sourcesTotalRow = database.prepare(`SELECT COUNT(*) AS total FROM source_items
    WHERE ${effectiveFilter} AND collected_at >= ? AND collected_at <= ?`).get(dayStart, dayEnd) as { total: number } | undefined;
  const todayRows = database.prepare(`${sourceSelect}
    WHERE ${effectiveFilter} AND collected_at >= ? AND collected_at <= ?
    ORDER BY collected_at DESC
    LIMIT 500`).all(dayStart, dayEnd) as SourceRow[];
  const latestSourceDateRow = database.prepare(`SELECT strftime('%Y-%m-%d', collected_at, '+8 hours') AS sourceDate
    FROM source_items WHERE ${effectiveFilter} ORDER BY collected_at DESC LIMIT 1`).get() as { sourceDate: string } | undefined;
  const latestSourceDate = todayRows.length ? planDate : (latestSourceDateRow?.sourceDate ?? null);
  const fallbackRows = todayRows.length || !latestSourceDate ? todayRows : database.prepare(`${sourceSelect}
    WHERE ${effectiveFilter} AND collected_at >= ? AND collected_at <= ?
    ORDER BY collected_at DESC
    LIMIT 500`).all(
      toUtcIsoBound(`${latestSourceDate}T00:00:00.000+08:00`),
      toUtcIsoBound(`${latestSourceDate}T23:59:59.999+08:00`)
    ) as SourceRow[];
  const avatarIndex = buildXAvatarIndex(database);
  const sources = mapSourceRows(fallbackRows, avatarIndex);
  const sourcesTotal = todayRows.length ? Number(sourcesTotalRow?.total || sources.length) : sources.length;
  const archivedTodayRow = database.prepare(`SELECT COUNT(*) AS total FROM source_items
    WHERE management_status = 'archived' AND collected_at >= ? AND collected_at <= ?`).get(dayStart, dayEnd) as { total: number } | undefined;
  const archivedTodayCount = Number(archivedTodayRow?.total ?? 0);
  const fermenting = listFermentingBundle(database, planDate);
  const plan = loadPlan(database, planDate);
  // current plan 可为当日空运行记录；主席兜底用最近非空方案（含同日被降级旧 plan）。
  const latestPlan = plan && plan.items.length > 0 ? null : loadLatestNonEmptyPlan(database, { excludePlanId: plan?.id ?? null });
  // 选题池与今日读模型同用 planDate 上海日界（dayEnd）锚定，避免真实墙钟漂移使当日窗口内机会提前过期。
  const poolNow = options.now ?? new Date();
  // No plan is not a human blocker: the primary CTA is「开始今日情报」, not a fake todo card.
  const topicMaintenance = { pending: Number((database.prepare("SELECT count(*) AS count FROM topic_maintenance_proposals WHERE status='proposed'").get() as { count: number }).count) };
  const sameDayTasks = collectSameDayTasks(database, planDate);
  const exhaustion = getTodayPlanExhaustion(database, planDate);
  let recommendation = buildTodayRecommendationProjection(database, planDate, { now: poolNow });
  const orchestrator = readManagerAdapterProjection(database, { businessDate: planDate });
  if (orchestrator.roots.length > 0) {
    recommendation = buildOrchestratorRecommendation(database, recommendation, orchestrator.roots, planDate, poolNow);
  }
  if (!recommendation.primary) {
    const active = sameDayTasks.find((item) => item.status === 'running');
    if (active) recommendation.emptyReason = ['judging_opportunities', 'synthesizing', 'validating'].includes(active.phase ?? '') ? 'scoring_active' : 'run_active';
    else if (!plan && sameDayTasks.length === 0 && orchestrator.roots.length === 0) recommendation.emptyReason = 'not_started';
  }
  return { sources, sourcesTotal, sourcesDate: latestSourceDate, plan, latestPlan, pool: recommendation.eligible, recommendation, orchestrator, pendingActions: [], topicMaintenance, fermenting, archivedTodayCount, sameDayTasks, exhaustion };
}

export type OpportunityPoolItem = {
  planItemId: string;
  planDate: string;
  title: string;
  priority: number;
  timeliness: string | null;
  timelinessClass: TimelinessClass;
  expiresAt: string | null;
  topicId: string | null;
  sourceIds: string[];
  whyNow: string;
  angle: string;
  pointOfView: string;
  targetAudience: string;
  platforms: string[];
  formats: string[];
  titleGuidance: string;
  openingGuidance: string;
  structureGuidance: string;
  effortEstimate: string;
  availableMaterials: string[];
  missingMaterials: string[];
  trendEvidence: XPostTrend[];
  createdAt: string;
  isNew: boolean;
  planningStatus: string | null;
  revision: number | null;
  planningProvenanceJson: string | null;
  scoreReasonsJson: string | null;
  carry: { id: string; state: string; revision: number } | null;
  demotion: { publishedAt: string; platform: string } | null;
};
export type OpportunityPoolOptions = {
  now?: Date;
  demoteHours?: number;
  newHours?: number;
};

export function parseSourceIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export type LatestPlanItemRow = {
  planItemId: string;
  title: string;
  priority: number;
  timeliness: string | null;
  topicId: string | null;
  whyNow: string;
  angle: string;
  pointOfView: string;
  sourceIds: string;
  createdAt: string;
  planDate: string;
  targetAudience: string;
  platforms: string;
  formats: string;
  titleGuidance: string;
  openingGuidance: string;
  structureGuidance: string;
  effortEstimate: string;
  availableMaterials: string;
  missingMaterials: string;
  planningStatus: string | null;
  revision: number | null;
  planningProvenanceJson: string | null;
  scoreReasonsJson: string | null;
};
/** 每个 plan_date 最近「非空」方案下的 plan_items（原始行）。台账与选题池共用。 */
export function latestPlanItemRowsByDate(database: DatabaseSync, limit = 200): LatestPlanItemRow[] {
  return database.prepare(`
    SELECT pi.id AS planItemId, pi.title, pi.priority, pi.timeliness, pi.topic_id AS topicId,
      pi.why_now AS whyNow, pi.angle, pi.point_of_view AS pointOfView, pi.source_ids_json AS sourceIds,
      pi.target_audience AS targetAudience, pi.platforms_json AS platforms, pi.formats_json AS formats,
      pi.title_guidance AS titleGuidance, pi.opening_guidance AS openingGuidance,
      pi.structure_guidance AS structureGuidance, pi.effort_estimate AS effortEstimate,
      pi.available_materials_json AS availableMaterials, pi.missing_materials_json AS missingMaterials,
      pi.planning_status AS planningStatus, pi.revision AS revision, pi.planning_provenance_json AS planningProvenanceJson, pi.score_reasons_json AS scoreReasonsJson,
      pi.created_at AS createdAt, p.plan_date AS planDate
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE p.id IN (
      SELECT p2.id FROM plans p2
      WHERE EXISTS (SELECT 1 FROM plan_items pi2 WHERE pi2.plan_id = p2.id)
        AND p2.created_at = (
          SELECT MAX(p3.created_at) FROM plans p3
          WHERE p3.plan_date = p2.plan_date
            AND EXISTS (SELECT 1 FROM plan_items pi3 WHERE pi3.plan_id = p3.id)
        )
    )
    ORDER BY pi.priority ASC, p.plan_date DESC, pi.sort_order ASC
    LIMIT ?
  `).all(limit) as LatestPlanItemRow[];
}

/** 开放清单 story 去重 + 排序（主席/今日可批共用）。 */
export function dedupeOpenProposals(items: OpportunityPoolItem[]): OpportunityPoolItem[] {
  const byStory: OpportunityPoolItem[] = [];
  for (const item of items) {
    const index = byStory.findIndex((keeper) => sameStory(keeper, item));
    if (index === -1) {
      byStory.push(item);
      continue;
    }
    const keeper = byStory[index];
    if (item.priority < keeper.priority || (item.priority === keeper.priority && item.createdAt > keeper.createdAt)) {
      byStory[index] = item;
    }
  }
  byStory.sort((a, b) =>
    Number(Boolean(a.demotion)) - Number(Boolean(b.demotion))
    || a.priority - b.priority
    || b.createdAt.localeCompare(a.createdAt)
  );
  return byStory;
}

/**
 * 选题池：跨日期未终结的 plan_items 并集。
 * 数据源 = 每个 plan_date 最近「非空」方案（不是 is_current：空 current 只是运行记录，不得挤掉可批项）。
 * 终结 = 已采纳（有项目）、被否决/已过期（carry 状态）、或超过时效窗口（爆点 24h / 热点 72h；长青不过期）。
 * 发布 24h 内同主题内容的机会降权标注。
 */
export function getOpportunityPool(database: DatabaseSync, options: OpportunityPoolOptions = {}): OpportunityPoolItem[] {
  const now = options.now ?? new Date();
  const businessDate = shanghaiDate(now);
  const legacy = buildTodayRecommendationProjection(database, businessDate, { now });
  const orchestrator = readManagerAdapterProjection(database, { businessDate });
  return orchestrator.roots.length > 0
    ? buildOrchestratorRecommendation(database, legacy, orchestrator.roots, businessDate, now).eligible
    : legacy.eligible;
}

export function getTodayOverviewMetrics(database: DatabaseSync, planDate: string, options: { now?: Date } = {}): {
  updatedAt: string;
  sources: { value: number | null; changeText: string; changeTone?: 'up' | 'down' | 'neutral'; series: Array<number | null> };
  opportunities: { value: number | null; changeText: string; changeTone?: 'up' | 'down' | 'neutral'; series: Array<number | null> };
  projects: { value: number | null; changeText: string; changeTone?: 'up' | 'down' | 'neutral'; series: Array<number | null>; pending: number | null };
  publications: { value: number | null; changeText: string; changeTone?: 'up' | 'down' | 'neutral'; series: Array<number | null> };
} {
  const metricNow = options.now ?? new Date();
  const updatedAt = metricNow.toISOString();
  function buildChange(current: number, previous: number): { changeText: string; changeTone?: 'up' | 'down' | 'neutral' } {
    if (previous === 0 && current === 0) return { changeText: '—', changeTone: 'neutral' };
    if (previous === 0 && current > 0) return { changeText: `新增 ${current}`, changeTone: 'up' };
    const delta = current - previous;
    const pct = Math.round((delta / previous) * 100);
    const tone: 'up' | 'down' | 'neutral' = delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral';
    const sign = delta > 0 ? '+' : '';
    return { changeText: `较昨日 ${sign}${pct}%`, changeTone: tone };
  }
  // --- sources ---
  let sourcesValue: number | null = null;
  let sourcesChangeText = '—';
  let sourcesTone: 'up' | 'down' | 'neutral' | undefined;
  let sourcesSeries: Array<number | null> = Array(7).fill(null);
  try {
    const dayStart = toUtcIsoBound(`${planDate}T00:00:00.000+08:00`);
    const dayEnd = toUtcIsoBound(`${planDate}T23:59:59.999+08:00`);
    const prevDate = addDaysDate(planDate, -1);
    const prevStart = toUtcIsoBound(`${prevDate}T00:00:00.000+08:00`);
    const prevEnd = toUtcIsoBound(`${prevDate}T23:59:59.999+08:00`);
    const todayRow = database.prepare(`SELECT COUNT(*) AS total FROM source_items WHERE management_status != 'archived' AND collected_at >= ? AND collected_at <= ?`).get(dayStart, dayEnd) as { total: number } | undefined;
    const prevRow = database.prepare(`SELECT COUNT(*) AS total FROM source_items WHERE management_status != 'archived' AND collected_at >= ? AND collected_at <= ?`).get(prevStart, prevEnd) as { total: number } | undefined;
    const cur = Number(todayRow?.total ?? 0);
    const prev = Number(prevRow?.total ?? 0);
    sourcesValue = cur;
    const ch = buildChange(cur, prev);
    sourcesChangeText = ch.changeText;
    sourcesTone = ch.changeTone;
    sourcesSeries = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDaysDate(planDate, -i);
      const s = toUtcIsoBound(`${d}T00:00:00.000+08:00`);
      const e = toUtcIsoBound(`${d}T23:59:59.999+08:00`);
      try {
        const r = database.prepare(`SELECT COUNT(*) AS total FROM source_items WHERE management_status != 'archived' AND collected_at >= ? AND collected_at <= ?`).get(s, e) as { total: number } | undefined;
        sourcesSeries.push(Number(r?.total ?? 0));
      } catch { sourcesSeries.push(null); }
    }
  } catch {
    sourcesValue = null;
    sourcesChangeText = '—';
    sourcesTone = undefined;
    sourcesSeries = Array(7).fill(null);
  }
  // --- opportunities (same authoritative recommendation projection as Today) ---
  let oppValue: number | null = null;
  let oppChangeText = '—';
  let oppTone: 'up' | 'down' | 'neutral' | undefined;
  let oppSeries: Array<number | null> = Array(7).fill(null);
  try {
    const curOpp = getOpportunityCountForDate(database, planDate, metricNow);
    const prevDate = addDaysDate(planDate, -1);
    const prevAsOf = new Date(toUtcIsoBound(`${prevDate}T23:59:59.999+08:00`));
    const prevOpp = getOpportunityCountForDate(database, prevDate, prevAsOf);
    oppValue = curOpp;
    const ch = buildChange(curOpp, prevOpp);
    oppChangeText = ch.changeText;
    oppTone = ch.changeTone;
    oppSeries = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDaysDate(planDate, -i);
      try {
        const cnt = getOpportunityCountForDate(database, d, new Date(toUtcIsoBound(`${d}T23:59:59.999+08:00`)));
        oppSeries.push(cnt);
      } catch { oppSeries.push(null); }
    }
  } catch {
    oppValue = null;
    oppChangeText = '—';
    oppTone = undefined;
    oppSeries = Array(7).fill(null);
  }
  // --- projects (active projects) ---
  let projValue: number | null = null;
  let projPending: number | null = null;
  let projChangeText = '—';
  let projTone: 'up' | 'down' | 'neutral' | undefined;
  let projSeries: Array<number | null> = Array(7).fill(null);
  try {
    const activeRow = database.prepare(`SELECT COUNT(*) AS total FROM content_projects WHERE archived_at IS NULL AND status != 'completed'`).get() as { total: number } | undefined;
    const pendingRow = database.prepare(`SELECT COUNT(*) AS total FROM content_projects WHERE archived_at IS NULL AND status IN ('idea','review','ready')`).get() as { total: number } | undefined;
    const curProj = Number(activeRow?.total ?? 0);
    projValue = curProj;
    projPending = Number(pendingRow?.total ?? 0);
    // For change, compare active count vs count of projects updated before yesterday? Simplify: compare to previous logical snapshot as same as pending? Use previous day's active snapshot via created/updated? Use flat for now.
    // Compute previous day's active via query with updated_at? Instead use same value minus maybe? Keep neutral.
    // Better: try historical active at prev day end via archived_at and created_at.
    let prevProj = curProj;
    try {
      const prevDate = addDaysDate(planDate, -1);
      const prevEnd = toUtcIsoBound(`${prevDate}T23:59:59.999+08:00`);
      const histRow = database.prepare(`SELECT COUNT(*) AS total FROM content_projects WHERE created_at <= ? AND (archived_at IS NULL OR archived_at > ?) AND status != 'completed'`).get(prevEnd, prevEnd) as { total: number } | undefined;
      prevProj = Number(histRow?.total ?? curProj);
    } catch { prevProj = curProj; }
    const ch = buildChange(curProj, prevProj);
    projChangeText = projPending != null && projPending > 0 ? `待处理 ${projPending}` : ch.changeText;
    projTone = ch.changeTone;
    if (projPending != null && projPending > 0) projTone = 'up';
    projSeries = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDaysDate(planDate, -i);
      const e = toUtcIsoBound(`${d}T23:59:59.999+08:00`);
      try {
        const r = database.prepare(`SELECT COUNT(*) AS total FROM content_projects WHERE created_at <= ? AND (archived_at IS NULL OR archived_at > ?) AND status != 'completed'`).get(e, e) as { total: number } | undefined;
        projSeries.push(Number(r?.total ?? 0));
      } catch { projSeries.push(curProj); }
    }
    if (projSeries.every((v) => v === curProj)) {
      // ensure variety if history not available, keep flat
    }
  } catch {
    projValue = null;
    projPending = null;
    projChangeText = '—';
    projTone = undefined;
    projSeries = Array(7).fill(null);
  }
  // --- publications (last 7 days) ---
  let pubValue: number | null = null;
  let pubChangeText = '—';
  let pubTone: 'up' | 'down' | 'neutral' | undefined;
  let pubSeries: Array<number | null> = Array(7).fill(null);
  try {
    const dayEnd = toUtcIsoBound(`${planDate}T23:59:59.999+08:00`);
    const weekStart = toUtcIsoBound(`${addDaysDate(planDate, -6)}T00:00:00.000+08:00`);
    const prevWeekStart = toUtcIsoBound(`${addDaysDate(planDate, -13)}T00:00:00.000+08:00`);
    const prevWeekEnd = toUtcIsoBound(`${addDaysDate(planDate, -7)}T23:59:59.999+08:00`);
    const curRow = database.prepare(`SELECT COUNT(*) AS total FROM publications WHERE status = 'published' AND published_at >= ? AND published_at <= ?`).get(weekStart, dayEnd) as { total: number } | undefined;
    const prevRow = database.prepare(`SELECT COUNT(*) AS total FROM publications WHERE status = 'published' AND published_at >= ? AND published_at <= ?`).get(prevWeekStart, prevWeekEnd) as { total: number } | undefined;
    const curPub = Number(curRow?.total ?? 0);
    const prevPub = Number(prevRow?.total ?? 0);
    pubValue = curPub;
    const ch = buildChange(curPub, prevPub);
    pubChangeText = ch.changeText;
    pubTone = ch.changeTone;
    pubSeries = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDaysDate(planDate, -i);
      const s = toUtcIsoBound(`${d}T00:00:00.000+08:00`);
      const e = toUtcIsoBound(`${d}T23:59:59.999+08:00`);
      try {
        const r = database.prepare(`SELECT COUNT(*) AS total FROM publications WHERE status = 'published' AND published_at >= ? AND published_at <= ?`).get(s, e) as { total: number } | undefined;
        pubSeries.push(Number(r?.total ?? 0));
      } catch { pubSeries.push(null); }
    }
  } catch {
    pubValue = null;
    pubChangeText = '—';
    pubTone = undefined;
    pubSeries = Array(7).fill(null);
  }
  return {
    updatedAt,
    sources: { value: sourcesValue, changeText: sourcesChangeText, changeTone: sourcesTone, series: sourcesSeries },
    opportunities: { value: oppValue, changeText: oppChangeText, changeTone: oppTone, series: oppSeries },
    projects: { value: projValue, changeText: projChangeText, changeTone: projTone, series: projSeries, pending: projPending },
    publications: { value: pubValue, changeText: pubChangeText, changeTone: pubTone, series: pubSeries },
  };
}
