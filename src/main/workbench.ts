import { DatabaseSync } from 'node:sqlite';

export type TodaySource = {
  id: string;
  title: string;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
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

export function getToday(database: DatabaseSync, planDate: string): {
  sources: TodaySource[];
  plan: { id: string; summary: string; items: TodayPlanItem[] } | null;
  pendingActions: string[];
} {
  const sourceRows = database.prepare(`SELECT id, title, canonical_url AS canonicalUrl, author, published_at AS publishedAt,
    summary, priority, categories_json AS categories, value_judgment AS valueJudgment
    FROM source_items ORDER BY priority DESC, collected_at DESC LIMIT 50`).all() as Array<Omit<TodaySource, 'categories'> & { categories: string }>;
  const sources = sourceRows.map((source) => ({ ...source, categories: JSON.parse(source.categories) as string[] }));
  const plan = database.prepare('SELECT id, summary FROM plans WHERE plan_date = ? AND is_current = 1').get(planDate) as { id: string; summary: string } | undefined;
  if (!plan) return { sources, plan: null, pendingActions: ['创建今日运营方案'] };
  const rows = database.prepare(`SELECT id, topic_id AS topicId, title, priority, why_now AS whyNow, timeliness,
    target_audience AS targetAudience, angle, point_of_view AS pointOfView, platforms_json AS platforms,
    formats_json AS formats, title_guidance AS titleGuidance, opening_guidance AS openingGuidance,
    structure_guidance AS structureGuidance, effort_estimate AS effortEstimate, source_ids_json AS sourceIds,
    available_materials_json AS availableMaterials, missing_materials_json AS missingMaterials
    FROM plan_items WHERE plan_id = ? ORDER BY sort_order`).all(plan.id) as Array<Omit<TodayPlanItem, 'platforms' | 'formats' | 'sourceIds' | 'availableMaterials' | 'missingMaterials'> & { platforms: string; formats: string; sourceIds: string; availableMaterials: string; missingMaterials: string }>;
  const items = rows.map((item) => ({
    ...item,
    platforms: JSON.parse(item.platforms) as string[],
    formats: JSON.parse(item.formats) as string[],
    sourceIds: JSON.parse(item.sourceIds) as string[],
    availableMaterials: JSON.parse(item.availableMaterials) as string[],
    missingMaterials: JSON.parse(item.missingMaterials) as string[]
  }));
  return { sources, plan: { ...plan, items }, pendingActions: [] };
}
