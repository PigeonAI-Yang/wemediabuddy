import { DatabaseSync } from 'node:sqlite';
import { classifyTimeliness, fingerprintPlanItem, listFermentingBundle, TIMELINESS_WINDOW_HOURS, type FermentingBundle, type TimelinessClass } from './ferment.ts';
import { hasProjectForPlanItemOrSources } from './ferment-read.ts';
import { listXPostTrends, type XPostTrend } from './x-post-metrics.ts';

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
};

type SourceRow = Omit<TodaySource, 'categories'> & { categories: string };
type TodayPlan = { id: string; planDate: string; summary: string; items: TodayPlanItem[] };

function mapSourceRows(rows: SourceRow[]): TodaySource[] {
  return rows.map((source) => ({ ...source, categories: JSON.parse(source.categories) as string[] }));
}

function loadPlan(database: DatabaseSync, planDate?: string): TodayPlan | null {
  const plan = (planDate
    ? database.prepare('SELECT id, plan_date AS planDate, summary FROM plans WHERE plan_date = ? AND is_current = 1').get(planDate)
    : database.prepare('SELECT id, plan_date AS planDate, summary FROM plans WHERE is_current = 1 ORDER BY plan_date DESC LIMIT 1').get()
  ) as { id: string; planDate: string; summary: string } | undefined;
  if (!plan) return null;
  const rows = database.prepare(`SELECT id, topic_id AS topicId, title, priority, why_now AS whyNow, timeliness,
    target_audience AS targetAudience, angle, point_of_view AS pointOfView, platforms_json AS platforms,
    formats_json AS formats, title_guidance AS titleGuidance, opening_guidance AS openingGuidance,
    structure_guidance AS structureGuidance, effort_estimate AS effortEstimate, source_ids_json AS sourceIds,
    available_materials_json AS availableMaterials, missing_materials_json AS missingMaterials
    FROM plan_items WHERE plan_id = ? ORDER BY priority ASC, sort_order ASC`).all(plan.id) as Array<Omit<TodayPlanItem, 'platforms' | 'formats' | 'sourceIds' | 'availableMaterials' | 'missingMaterials' | 'trendEvidence'> & { platforms: string; formats: string; sourceIds: string; availableMaterials: string; missingMaterials: string }>;
  const items = rows.map((item) => {
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
  return { ...plan, items };
}

export function getToday(database: DatabaseSync, planDate: string): {
  sources: TodaySource[];
  sourcesTotal: number;
  sourcesDate: string | null;
  plan: TodayPlan | null;
  latestPlan: TodayPlan | null;
  pool: OpportunityPoolItem[];
  pendingActions: string[];
  fermenting: FermentingBundle;
} {
  // Freshness rail: prefer sources collected on the plan date.
  // Fermenting rail (cross-day) is separate and returned as fermenting.*.
  const dayStart = `${planDate}T00:00:00.000+08:00`;
  const dayEnd = `${planDate}T23:59:59.999+08:00`;
  const sourceSelect = `SELECT id, title, canonical_url AS canonicalUrl, author, published_at AS publishedAt,
    collected_at AS collectedAt, summary, priority, categories_json AS categories, value_judgment AS valueJudgment
    FROM source_items`;
  const sourcesTotalRow = database.prepare(`SELECT COUNT(*) AS total FROM source_items
    WHERE collected_at >= ? AND collected_at <= ?`).get(dayStart, dayEnd) as { total: number };
  const todayRows = database.prepare(`${sourceSelect}
    WHERE collected_at >= ? AND collected_at <= ?
    ORDER BY collected_at DESC
    LIMIT 500`).all(dayStart, dayEnd) as SourceRow[];
  const latestSourceDate = todayRows.length ? planDate : ((database.prepare(`SELECT strftime('%Y-%m-%d', collected_at, '+8 hours') AS sourceDate
    FROM source_items ORDER BY collected_at DESC LIMIT 1`).get() as { sourceDate: string } | undefined)?.sourceDate ?? null);
  const fallbackRows = todayRows.length || !latestSourceDate ? todayRows : database.prepare(`${sourceSelect}
    WHERE collected_at >= ? AND collected_at <= ?
    ORDER BY collected_at DESC
    LIMIT 500`).all(`${latestSourceDate}T00:00:00.000+08:00`, `${latestSourceDate}T23:59:59.999+08:00`) as SourceRow[];
  const sources = mapSourceRows(fallbackRows);
  const sourcesTotal = todayRows.length ? Number(sourcesTotalRow?.total || sources.length) : sources.length;
  const fermenting = listFermentingBundle(database, planDate);
  const plan = loadPlan(database, planDate);
  const latestPlan = plan ? null : loadPlan(database);
  // No plan is not a human blocker: the primary CTA is「开始今日情报」, not a fake todo card.
  return { sources, sourcesTotal, sourcesDate: latestSourceDate, plan, latestPlan, pool: getOpportunityPool(database), pendingActions: [], fermenting };
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
  carry: { id: string; state: string; revision: number } | null;
  demotion: { publishedAt: string; platform: string } | null;
};

export type OpportunityPoolOptions = {
  now?: Date;
  demoteHours?: number;
  newHours?: number;
};

function parseSourceIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 机会池：跨日期未终结的 plan_items 并集。终结 = 已采纳（有项目）、被否决/已过期（carry 状态）、
 * 或超过时效窗口（爆点 24h / 热点 72h；长青不过期）。发布 24h 内同主题内容的机会降权标注。
 */
export function getOpportunityPool(database: DatabaseSync, options: OpportunityPoolOptions = {}): OpportunityPoolItem[] {
  const now = options.now ?? new Date();
  const demoteHours = options.demoteHours ?? 24;
  const newHours = options.newHours ?? 6;
  // 不按方案时间截断：终结（采纳/否决/过期）与时效窗口负责淘汰；长青机会不受新近度限制。
  const rows = database.prepare(`
    SELECT pi.id AS planItemId, pi.title, pi.priority, pi.timeliness, pi.topic_id AS topicId,
      pi.why_now AS whyNow, pi.angle, pi.point_of_view AS pointOfView, pi.source_ids_json AS sourceIds,
      pi.target_audience AS targetAudience, pi.platforms_json AS platforms, pi.formats_json AS formats,
      pi.title_guidance AS titleGuidance, pi.opening_guidance AS openingGuidance,
      pi.structure_guidance AS structureGuidance, pi.effort_estimate AS effortEstimate,
      pi.available_materials_json AS availableMaterials, pi.missing_materials_json AS missingMaterials,
      pi.created_at AS createdAt, p.plan_date AS planDate
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE p.is_current = 1
    ORDER BY pi.priority ASC, p.plan_date DESC, pi.sort_order ASC
    LIMIT 200
  `).all() as Array<{
    planItemId: string; title: string; priority: number; timeliness: string | null; topicId: string | null;
    whyNow: string; angle: string; pointOfView: string; sourceIds: string; createdAt: string; planDate: string;
    targetAudience: string; platforms: string; formats: string; titleGuidance: string; openingGuidance: string;
    structureGuidance: string; effortEstimate: string; availableMaterials: string; missingMaterials: string;
  }>;

  const demoteSince = new Date(now.getTime() - demoteHours * 3_600_000).toISOString();
  const latestPublicationByTopic = new Map<string, { publishedAt: string; platform: string }>(
    (database.prepare(`
      SELECT cp.topic_id AS topicId, p.platform, p.published_at AS publishedAt
      FROM publications p
      JOIN platform_versions pv ON pv.id = p.platform_version_id
      JOIN content_projects cp ON cp.id = pv.project_id
      WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at >= ? AND cp.topic_id IS NOT NULL
      ORDER BY p.published_at DESC
    `).all(demoteSince) as Array<{ topicId: string; platform: string; publishedAt: string }>)
      .filter((row, index, all) => all.findIndex((other) => other.topicId === row.topicId) === index)
      .map((row) => [row.topicId, { publishedAt: row.publishedAt, platform: row.platform }])
  );

  const carryStmt = database.prepare(`SELECT id, state, revision FROM work_carry_items WHERE object_type='plan_item' AND fingerprint=?`);
  const pool: OpportunityPoolItem[] = [];
  for (const row of rows) {
    const sourceIds = parseSourceIds(row.sourceIds);
    if (hasProjectForPlanItemOrSources(database, row.planItemId, sourceIds)) continue;
    const fingerprint = fingerprintPlanItem({ title: row.title, topicId: row.topicId, sourceIds });
    const carry = carryStmt.get(fingerprint) as { id: string; state: string; revision: number } | undefined;
    if (carry && (carry.state === 'dismissed' || carry.state === 'expired' || carry.state === 'done')) continue;

    const timelinessClass = classifyTimeliness(row.timeliness);
    const windowHours = TIMELINESS_WINDOW_HOURS[timelinessClass];
    const expiresAt = windowHours === null ? null : new Date(Date.parse(row.createdAt) + windowHours * 3_600_000).toISOString();
    if (expiresAt && Date.parse(expiresAt) <= now.getTime()) continue;

    pool.push({
      planItemId: row.planItemId,
      planDate: row.planDate,
      title: row.title,
      priority: row.priority,
      timeliness: row.timeliness,
      timelinessClass,
      expiresAt,
      topicId: row.topicId,
      sourceIds,
      whyNow: row.whyNow,
      angle: row.angle,
      pointOfView: row.pointOfView,
      targetAudience: row.targetAudience,
      platforms: parseSourceIds(row.platforms),
      formats: parseSourceIds(row.formats),
      titleGuidance: row.titleGuidance,
      openingGuidance: row.openingGuidance,
      structureGuidance: row.structureGuidance,
      effortEstimate: row.effortEstimate,
      availableMaterials: parseSourceIds(row.availableMaterials),
      missingMaterials: parseSourceIds(row.missingMaterials),
      trendEvidence: listXPostTrends(database, { sourceIds }),
      createdAt: row.createdAt,
      isNew: Date.parse(row.createdAt) >= now.getTime() - newHours * 3_600_000,
      carry: carry ? { id: carry.id, state: carry.state, revision: carry.revision } : null,
      demotion: row.topicId ? latestPublicationByTopic.get(row.topicId) ?? null : null
    });
  }
  pool.sort((a, b) =>
    Number(Boolean(a.demotion)) - Number(Boolean(b.demotion))
    || a.priority - b.priority
    || b.createdAt.localeCompare(a.createdAt)
  );
  return pool;
}

export function getFermentingOnly(database: DatabaseSync, planDate: string): FermentingBundle {
  return listFermentingBundle(database, planDate);
}
