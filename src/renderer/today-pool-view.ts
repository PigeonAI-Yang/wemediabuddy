import type { TodayPlanItem } from '../main/workbench';

export type PoolItemLike = {
  planItemId: string;
  planDate: string;
  title: string;
  priority: number;
  timeliness: string | null;
  timelinessClass: 'breaking' | 'hot' | 'evergreen';
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
  trendEvidence: TodayPlanItem['trendEvidence'];
  createdAt: string;
  isNew: boolean;
  demotion: { publishedAt: string; platform: string } | null;
};

export type PoolBadge =
  | { kind: 'new'; text: string }
  | { kind: 'timeliness'; text: string; tone: 'breaking' | 'hot' | 'evergreen' }
  | { kind: 'expiry'; text: string }
  | { kind: 'written'; text: string }
  | { kind: 'demotion'; text: string }
  | { kind: 'pending'; text: string };

const CLASS_LABELS: Record<PoolItemLike['timelinessClass'], string> = {
  breaking: '爆点',
  hot: '热点',
  evergreen: '长青'
};

/**
 * 池项 → Opportunity 卡片所需的 TodayPlanItem 形状。planItemId 直接作为 item.id，
 * 采纳路径（createProjectFromPlanItem）与选择状态无需任何分支。
 */
export function poolItemToPlanItem(item: PoolItemLike): TodayPlanItem {
  return {
    id: item.planItemId,
    topicId: item.topicId,
    title: item.title,
    priority: item.priority,
    whyNow: item.whyNow,
    timeliness: item.timeliness ?? '',
    targetAudience: item.targetAudience,
    angle: item.angle,
    pointOfView: item.pointOfView,
    platforms: item.platforms,
    formats: item.formats,
    titleGuidance: item.titleGuidance,
    openingGuidance: item.openingGuidance,
    structureGuidance: item.structureGuidance,
    effortEstimate: item.effortEstimate,
    sourceIds: item.sourceIds,
    availableMaterials: item.availableMaterials,
    missingMaterials: item.missingMaterials,
    trendEvidence: item.trendEvidence
  };
}

/**
 * 主席清单投影：选题池（未终结 open 项）是主区的唯一数据源。
 * getToday 的 pool = 跨日期未终结 plan_items 并集（已采纳/已否掉/已过期/超窗全部被排除），
 * 因此池为空即意味着没有任何可展示的机会。回退到今日/最近非空方案会把这些已被终结的
 * 条目重新搬回主区（否掉最后一条机会后卡片“复活”），故不再回退。
 * 当日空 current plan 只是运行记录，由 pool 跨日并集兜底，主区不会被掏空。
 */
export function resolveChairDisplayItems<TPool extends PoolItemLike, TPlan extends { items: TodayPlanItem[] }>(
  pool: TPool[] | null | undefined,
  _todayPlan: TPlan | null | undefined,
  _latestPlan: TPlan | null | undefined
): TodayPlanItem[] {
  if (pool && pool.length > 0) return pool.map(poolItemToPlanItem);
  return [];
}

export function poolBadgeClass(badge: PoolBadge): string {
  if (badge.kind === 'new') return 'pool-new';
  if (badge.kind === 'timeliness') return `pool-${badge.tone}`;
  if (badge.kind === 'demotion') return 'pool-demotion';
  if (badge.kind === 'pending') return 'pool-pending';
  if (badge.kind === 'written') return 'pool-written';
  return 'gray';
}

function formatWrittenAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const stamp = `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
  return stamp.includes('undefined') || !pick('year') ? null : `写入 ${stamp}`;
}

export function poolBadges(item: PoolItemLike, nowMs: number, planDate?: string): PoolBadge[] {
  const badges: PoolBadge[] = [];
  if (item.isNew) badges.push({ kind: 'new', text: '新' });
  badges.push({ kind: 'timeliness', text: CLASS_LABELS[item.timelinessClass], tone: item.timelinessClass });
  if (planDate && item.planDate && item.planDate < planDate) badges.push({ kind: 'pending', text: '待处理' });
  if (item.expiresAt) {
    const remainMs = Date.parse(item.expiresAt) - nowMs;
    if (remainMs > 0) {
      const hours = Math.floor(remainMs / 3_600_000);
      badges.push({ kind: 'expiry', text: hours >= 1 ? `还剩 ~${hours}h` : `还剩 ~${Math.max(1, Math.round(remainMs / 60_000))}m` });
    }
  }
  const written = formatWrittenAt(item.createdAt);
  if (written) badges.push({ kind: 'written', text: written });
  if (item.demotion) badges.push({ kind: 'demotion', text: '刚发布过同主题' });
  return badges;
}
