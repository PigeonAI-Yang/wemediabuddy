import type { DatabaseSync } from 'node:sqlite';
import { listFermentingBundle, shanghaiDate, type FermentingBundle } from './ferment.ts';
import { listWatchingSources } from './knowledge.ts';
import { listXPostTrends, type XPostTrend } from './x-post-metrics.ts';
import { readWorkspaceProfile } from './workspace-profiles.ts';
import { listReactivatedEvidencePacks, type ReactivatedEvidencePack } from './knowledge-reactivation.ts';

export type BriefIdentity = {
  displayName: string;
  audience: string;
  contentGoal: string;
  editorialBrief: string;
  platforms: string[];
};

export type BriefPublishedItem = {
  projectTitle: string;
  topicTitle: string | null;
  platform: string;
  publishedAt: string;
};

export type BriefReview = {
  id: string;
  summary: string | null;
  keep: string[];
  stop: string[];
  change: string[];
  finalizedAt: string | null;
};

export type BriefFinding = { id: string; title: string; body: string; updatedAt: string };

export type BriefWatchingSource = {
  id: string;
  title: string;
  topics: string;
  priority: number | null;
};

export type BriefIncrementSource = {
  id: string;
  title: string;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  collectedAt: string;
  summary: string | null;
  categories: string[];
  valueJudgment: string | null;
  timeliness: string | null;
  priority: number | null;
};

export type EditorialBrief = {
  generatedAt: string;
  businessDate: string;
  identity: BriefIdentity | null;
  history: {
    publishedDays: number;
    published: BriefPublishedItem[];
    reviews: BriefReview[];
    findings: BriefFinding[];
  };
  inventory: {
    watching: BriefWatchingSource[];
    fermenting: FermentingBundle;
    trends: XPostTrend[];
  };
  continuity: {
    reactivated: readonly ReactivatedEvidencePack[];
  };
  increment: {
    watermark: string | null;
    since: string;
    sources: BriefIncrementSource[];
    truncated: boolean;
    /** 有效资料库口径：本轮（since 窗口内）被资料门判为与本赛道无关的条数与原因码 Top3。 */
    laneFiltered: {
      count: number;
      reasonCodes: Array<{ code: string; count: number }>;
    };
  };
};

export type AssembleBriefOptions = {
  now?: Date;
  businessDate?: string;
  watermark?: string | null;
  fallbackHours?: number;
  publishedDays?: number;
  reviewLimit?: number;
  findingLimit?: number;
  sourceLimit?: number;
};

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function assembleEditorialBrief(database: DatabaseSync, options: AssembleBriefOptions = {}): EditorialBrief {
  const now = options.now ?? new Date();
  const watermark = options.watermark ?? null;
  const fallbackHours = options.fallbackHours ?? 24;
  const publishedDays = options.publishedDays ?? 30;
  const reviewLimit = options.reviewLimit ?? 3;
  const findingLimit = options.findingLimit ?? 5;
  const sourceLimit = options.sourceLimit ?? 60;
  const businessDate = options.businessDate ?? shanghaiDate(now);

  const profile = readWorkspaceProfile(database);
  const identity: BriefIdentity | null = profile
    ? {
        displayName: profile.displayName,
        audience: profile.audience,
        contentGoal: profile.contentGoal,
        editorialBrief: profile.editorialBrief,
        platforms: [...profile.platforms]
      }
    : null;

  const publishedSince = new Date(now.getTime() - publishedDays * 86_400_000).toISOString();
  const published = database.prepare(`
    SELECT cp.title AS projectTitle, t.title AS topicTitle, p.platform, p.published_at AS publishedAt
    FROM publications p
    JOIN platform_versions pv ON pv.id = p.platform_version_id
    JOIN content_projects cp ON cp.id = pv.project_id
    LEFT JOIN topics t ON t.id = cp.topic_id
    WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at >= ?
    ORDER BY p.published_at DESC
    LIMIT 30
  `).all(publishedSince) as BriefPublishedItem[];

  const reviewRows = database.prepare(`
    SELECT id, summary, keep_json AS keepJson, stop_json AS stopJson, change_json AS changeJson,
      finalized_at AS finalizedAt, updated_at AS updatedAt
    FROM reviews WHERE status = 'final'
    ORDER BY coalesce(finalized_at, updated_at) DESC
    LIMIT ?
  `).all(reviewLimit) as Array<{ id: string; summary: string | null; keepJson: string; stopJson: string; changeJson: string; finalizedAt: string | null }>;
  const reviews: BriefReview[] = reviewRows.map((row) => ({
    id: row.id,
    summary: row.summary,
    keep: parseJsonArray(row.keepJson),
    stop: parseJsonArray(row.stopJson),
    change: parseJsonArray(row.changeJson),
    finalizedAt: row.finalizedAt
  }));

  const findings = database.prepare(`
    SELECT id, title, body, updated_at AS updatedAt
    FROM method_findings ORDER BY updated_at DESC LIMIT ?
  `).all(findingLimit) as BriefFinding[];

  // 读侧只取发酵池快照；过期/播种/衰减等写操作由判断流程经 dispatcher 单独执行（WMB_WRITE 守卫）。
  const fermenting = listFermentingBundle(database, businessDate);
  const watching = (listWatchingSources(database, 20) as Array<{ id: string; title: string; topics: string; priority: number | null }>).map((item) => ({
    id: item.id,
    title: item.title,
    topics: item.topics,
    priority: item.priority
  }));
  const trends = listXPostTrends(database, { limit: 20 });

  const since = watermark ?? new Date(now.getTime() - fallbackHours * 3_600_000).toISOString();
  // Editorial signal quota: guarantee bounded demand/social signals before filling recent rows.
  // Signals are real questions/comments/controversy where represented (current schema: categories_json contains signal_only/demand/question)
  // and retain trust labels (never promoted to primary evidence). No source-specific hardcoding.
  const SIGNAL_QUOTA = Math.min(10, Math.max(4, Math.floor(sourceLimit * 0.17))); // ~17% for 60 → 10, bounded
  const signalRows = database.prepare(`
    SELECT id, title, canonical_url AS canonicalUrl, author, published_at AS publishedAt,
      collected_at AS collectedAt, summary, categories_json AS categories, value_judgment AS valueJudgment,
      timeliness, priority
    FROM source_items
    WHERE collected_at > ? AND management_status != 'archived'
      AND (categories_json LIKE '%signal_only%' OR categories_json LIKE '%demand%' OR categories_json LIKE '%question%' OR categories_json LIKE '%controversy%')
    ORDER BY collected_at DESC
    LIMIT ?
  `).all(since, SIGNAL_QUOTA) as Array<Omit<BriefIncrementSource, 'categories'> & { categories: string }>;
  // Recent rows including potential overflow for deduplication
  const recentRows = database.prepare(`
    SELECT id, title, canonical_url AS canonicalUrl, author, published_at AS publishedAt,
      collected_at AS collectedAt, summary, categories_json AS categories, value_judgment AS valueJudgment,
      timeliness, priority
    FROM source_items
    WHERE collected_at > ? AND management_status != 'archived'
    ORDER BY collected_at DESC
    LIMIT ?
  `).all(since, sourceLimit + 1) as Array<Omit<BriefIncrementSource, 'categories'> & { categories: string }>;
  // Merge: guaranteed signals first, then fill with recent not already included
  const signalIds = new Set(signalRows.map((r) => r.id));
  const filteredRecent = recentRows.filter((r) => !signalIds.has(r.id));
  const neededFromRecent = Math.max(0, sourceLimit - signalRows.length);
  const combined = [...signalRows, ...filteredRecent.slice(0, neededFromRecent)];
  // If signals filled quota but recent had more beyond limit, we already handled truncated via recentRows overflow check
  // To preserve recency ordering: sort combined by collected_at DESC before slice, but signals should not be dropped if they are older
  // Instead, we keep signal guarantee: sort combined DESC, then slice to sourceLimit, ensuring at least min(signalRows.length, SIGNAL_QUOTA) signals survive
  combined.sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt)));
  const truncated = recentRows.length > neededFromRecent;
  const orderedRows = combined.slice(0, sourceLimit).sort((a, b) => String(a.collectedAt).localeCompare(String(b.collectedAt)));
  const sources: BriefIncrementSource[] = orderedRows.map((row) => ({
    ...row,
    summary: typeof row.summary === 'string' && row.summary.length > 500 ? `${row.summary.slice(0, 500)}…` : row.summary,
    categories: parseJsonArray(row.categories)
  }));
  const reactivated = listReactivatedEvidencePacks(database, { limit: 20, since });
  // 本轮透明计数：source_lane_judgments（WMB-4941 流水表，migrateDatabase 必经 v46）在 since 窗口内
  // 被判 irrelevant 的条数 + 原因码 Top3，供编辑自审（「本轮另判 N 条与本赛道无关」）。
  const laneFilteredCountRow = database.prepare(`
    SELECT count(*) AS count FROM source_lane_judgments
    WHERE decision = 'irrelevant' AND judged_at >= ?
  `).get(since) as { count: number };
  const laneFilteredReasonRows = database.prepare(`
    SELECT reason_code AS code, count(*) AS count
    FROM source_lane_judgments
    WHERE decision = 'irrelevant' AND judged_at >= ?
    GROUP BY reason_code
    ORDER BY count(*) DESC, reason_code ASC
    LIMIT 3
  `).all(since) as Array<{ code: string; count: number }>;
  const laneFiltered = {
    count: Number(laneFilteredCountRow?.count ?? 0),
    reasonCodes: laneFilteredReasonRows.map((row) => ({ code: row.code, count: Number(row.count) }))
  };

  return {
    generatedAt: now.toISOString(),
    businessDate,
    identity,
    history: { publishedDays, published, reviews, findings },
    inventory: { watching, fermenting, trends },
    continuity: { reactivated },
    increment: { watermark, since, sources, truncated, laneFiltered }
  };
}

export function renderEditorialBrief(brief: EditorialBrief): string {
  const lines: string[] = [`【编辑简报 · 生成于 ${brief.generatedAt} · 业务日期 ${brief.businessDate}】`, ''];

  lines.push('■ 身份（本工作空间立场，判断一切机会前必须先读）');
  if (brief.identity) {
    lines.push(`工作空间：${brief.identity.displayName}`);
    lines.push(`受众：${brief.identity.audience}`);
    lines.push(`内容目标：${brief.identity.contentGoal}`);
    lines.push(`编辑简报：${brief.identity.editorialBrief}`);
    lines.push(`平台：${brief.identity.platforms.join(' / ')}`);
  } else {
    lines.push('（未配置工作空间配方）');
  }
  lines.push('');

  lines.push(`■ 历史（你最近写过什么、复盘学到什么；判断必须避免撞题并吸收教训）`);
  lines.push(`近 ${brief.history.publishedDays} 天已发布：`);
  lines.push(brief.history.published.length ? JSON.stringify(brief.history.published, null, 1) : '（无）');
  lines.push('最近复盘（final）：');
  lines.push(brief.history.reviews.length ? JSON.stringify(brief.history.reviews, null, 1) : '（无）');
  lines.push('方法库结论：');
  lines.push(brief.history.findings.length ? JSON.stringify(brief.history.findings, null, 1) : '（无）');
  lines.push('');

  lines.push('■ 存量（跨天连续性，只用于判断，禁止为此另行扫描新来源）');
  lines.push(`观察中：${JSON.stringify(brief.inventory.watching)}`);
  lines.push(`持续关注：${JSON.stringify({
    items: brief.inventory.fermenting.items.slice(0, 5).map((item) => ({
      title: item.title, state: item.state, priority: item.priority,
      fermentedDays: item.fermentedDays, reason: item.reason,
      aftershocks: item.aftershocks.slice(0, 2).map((shock) => shock.title)
    })),
    topics: brief.inventory.fermenting.topics.slice(0, 5)
  })}`);
  lines.push(`趋势证据：${JSON.stringify(brief.inventory.trends.map((trend) => ({
    sourceItemId: trend.sourceItemId, status: trend.status, reason: trend.reason,
    viewsPerHour: trend.viewsPerHour, velocityChange: trend.velocityChange,
    capturedAt: trend.snapshots.at(-1)?.capturedAt ?? null
  })))}`);
  lines.push('');

  lines.push('■ 本轮重新激活的跨日证据（仅这些 Source 与本轮增量可供 Planner 引用）');
  lines.push(brief.continuity.reactivated.length ? JSON.stringify(brief.continuity.reactivated, null, 1) : '（无）');
  lines.push('');

  const scope = brief.increment.watermark ? `水印 ${brief.increment.watermark} 之后` : `回看自 ${brief.increment.since}`;
  lines.push(`■ 增量（本轮新入库资料，${scope}，共 ${brief.increment.sources.length} 条${brief.increment.truncated ? '，已截断' : ''}）`);
  lines.push(brief.increment.sources.length ? JSON.stringify(brief.increment.sources, null, 1) : '（本轮无新资料）');
  if (brief.increment.laneFiltered.count > 0) {
    const reasons = brief.increment.laneFiltered.reasonCodes.map((item) => `${item.code}×${item.count}`).join('、');
    lines.push(`（本轮另有 ${brief.increment.laneFiltered.count} 条与本赛道无关，已移出有效库${reasons ? `：${reasons}` : ''}）`);
  }

  return lines.join('\n');
}
