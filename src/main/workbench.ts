import { DatabaseSync } from 'node:sqlite';
import { listFermentingBundle, refreshWorkCarry, type FermentingBundle } from './ferment.ts';

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
};

type SourceRow = Omit<TodaySource, 'categories'> & { categories: string };

function mapSourceRows(rows: SourceRow[]): TodaySource[] {
  return rows.map((source) => ({ ...source, categories: JSON.parse(source.categories) as string[] }));
}

export function getToday(database: DatabaseSync, planDate: string): {
  sources: TodaySource[];
  sourcesTotal: number;
  plan: { id: string; summary: string; items: TodayPlanItem[] } | null;
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
  const fallbackRows = todayRows.length
    ? todayRows
    : database.prepare(`${sourceSelect}
      ORDER BY collected_at DESC
      LIMIT 500`).all() as SourceRow[];
  const sources = mapSourceRows(fallbackRows);
  const sourcesTotal = todayRows.length ? Number(sourcesTotalRow?.total || sources.length) : sources.length;
  const fermenting = refreshWorkCarry(database, planDate);
  const plan = database.prepare('SELECT id, summary FROM plans WHERE plan_date = ? AND is_current = 1').get(planDate) as { id: string; summary: string } | undefined;
  if (!plan) return { sources, sourcesTotal, plan: null, pendingActions: ['创建今日运营方案'], fermenting };
  const rows = database.prepare(`SELECT id, topic_id AS topicId, title, priority, why_now AS whyNow, timeliness,
    target_audience AS targetAudience, angle, point_of_view AS pointOfView, platforms_json AS platforms,
    formats_json AS formats, title_guidance AS titleGuidance, opening_guidance AS openingGuidance,
    structure_guidance AS structureGuidance, effort_estimate AS effortEstimate, source_ids_json AS sourceIds,
    available_materials_json AS availableMaterials, missing_materials_json AS missingMaterials
    FROM plan_items WHERE plan_id = ? ORDER BY priority ASC, sort_order ASC`).all(plan.id) as Array<Omit<TodayPlanItem, 'platforms' | 'formats' | 'sourceIds' | 'availableMaterials' | 'missingMaterials'> & { platforms: string; formats: string; sourceIds: string; availableMaterials: string; missingMaterials: string }>;
  const items = rows.map((item) => ({
    ...item,
    platforms: JSON.parse(item.platforms) as string[],
    formats: JSON.parse(item.formats) as string[],
    sourceIds: JSON.parse(item.sourceIds) as string[],
    availableMaterials: JSON.parse(item.availableMaterials) as string[],
    missingMaterials: JSON.parse(item.missingMaterials) as string[]
  }));
  return { sources, sourcesTotal, plan: { ...plan, items }, pendingActions: [], fermenting };
}

export function getFermentingOnly(database: DatabaseSync, planDate: string): FermentingBundle {
  return listFermentingBundle(database, planDate);
}
