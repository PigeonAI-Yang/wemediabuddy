import { DatabaseSync } from 'node:sqlite';
import { classifyTimeliness, fingerprintPlanItem, listFermentingBundle, TIMELINESS_WINDOW_HOURS, type FermentingBundle, type TimelinessClass } from './ferment.ts';
import { hasProjectForPlanItemOrSources, sameStory, toUtcIsoBound } from './ferment-read.ts';
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
};

type SourceRow = Omit<TodaySource, 'categories' | 'avatarUrl'> & { categories: string; evidence: string | null };
type TodayPlan = { id: string; planDate: string; summary: string; items: TodayPlanItem[] };

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
    available_materials_json AS availableMaterials, missing_materials_json AS missingMaterials
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

export function getToday(database: DatabaseSync, planDate: string): {
  sources: TodaySource[];
  sourcesTotal: number;
  sourcesDate: string | null;
  plan: TodayPlan | null;
  latestPlan: TodayPlan | null;
  pool: OpportunityPoolItem[];
  pendingActions: string[];
  topicMaintenance: { pending: number };
  fermenting: FermentingBundle;
  /** 有效资料库口径：当日已移出（archived）条数，供 feed 行尾「另有 N 条与本赛道无关」计数。 */
  archivedTodayCount: number;
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
  const poolNow = new Date(dayEnd);
  // No plan is not a human blocker: the primary CTA is「开始今日情报」, not a fake todo card.
  const topicMaintenance = { pending: Number((database.prepare("SELECT count(*) AS count FROM topic_maintenance_proposals WHERE status='proposed'").get() as { count: number }).count) };
  return { sources, sourcesTotal, sourcesDate: latestSourceDate, plan, latestPlan, pool: getOpportunityPool(database, { now: poolNow }), pendingActions: [], topicMaintenance, fermenting, archivedTodayCount };
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
  const demoteHours = options.demoteHours ?? 24;
  const newHours = options.newHours ?? 6;
  const rows = latestPlanItemRowsByDate(database, 200);

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
    // 坏日期（created_at 不可解析）不炸整页：视为无时效窗（不推进过期判断），其余字段照常渲染。
    const createdMs = Date.parse(row.createdAt);
    const expiresAt = windowHours === null || !Number.isFinite(createdMs)
      ? null
      : new Date(createdMs + windowHours * 3_600_000).toISOString();
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
  return dedupeOpenProposals(pool);
}

export function getFermentingOnly(database: DatabaseSync, planDate: string): FermentingBundle {
  return listFermentingBundle(database, planDate);
}
