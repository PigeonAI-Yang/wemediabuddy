import type { DatabaseSync } from 'node:sqlite';
import { listFermentingBundle, shanghaiDate, type FermentingBundle } from './ferment.ts';
import { listWatchingSources } from './knowledge.ts';
import { listXPostTrends, type XPostTrend } from './x-post-metrics.ts';
import { readWorkspaceProfile } from './workspace-profiles.ts';

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
  increment: {
    watermark: string | null;
    since: string;
    sources: BriefIncrementSource[];
    truncated: boolean;
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
  // 最新优先：截断时保留最新资料（旧实现升序截断会把最新资料丢掉）。
  const incrementRows = database.prepare(`
    SELECT id, title, canonical_url AS canonicalUrl, author, published_at AS publishedAt,
      collected_at AS collectedAt, summary, categories_json AS categories, value_judgment AS valueJudgment,
      timeliness, priority
    FROM source_items
    WHERE collected_at > ?
    ORDER BY collected_at DESC
    LIMIT ?
  `).all(since, sourceLimit + 1) as Array<Omit<BriefIncrementSource, 'categories'> & { categories: string }>;
  const truncated = incrementRows.length > sourceLimit;
  const sources: BriefIncrementSource[] = incrementRows.slice(0, sourceLimit).reverse().map((row) => ({
    ...row,
    summary: typeof row.summary === 'string' && row.summary.length > 500 ? `${row.summary.slice(0, 500)}…` : row.summary,
    categories: parseJsonArray(row.categories)
  }));

  return {
    generatedAt: now.toISOString(),
    businessDate,
    identity,
    history: { publishedDays, published, reviews, findings },
    inventory: { watching, fermenting, trends },
    increment: { watermark, since, sources, truncated }
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
  lines.push(`发酵池：${JSON.stringify({
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

  const scope = brief.increment.watermark ? `水印 ${brief.increment.watermark} 之后` : `回看自 ${brief.increment.since}`;
  lines.push(`■ 增量（本轮新入库资料，${scope}，共 ${brief.increment.sources.length} 条${brief.increment.truncated ? '，已截断' : ''}）`);
  lines.push(brief.increment.sources.length ? JSON.stringify(brief.increment.sources, null, 1) : '（本轮无新资料）');

  return lines.join('\n');
}
