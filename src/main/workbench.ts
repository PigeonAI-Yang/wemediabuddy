import { DatabaseSync } from 'node:sqlite';
import { listFermentingBundle, type FermentingBundle } from './ferment.ts';
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
  return { sources, sourcesTotal, sourcesDate: latestSourceDate, plan, latestPlan, pendingActions: plan ? [] : ['创建今日运营方案'], fermenting };
}

export function getFermentingOnly(database: DatabaseSync, planDate: string): FermentingBundle {
  return listFermentingBundle(database, planDate);
}
