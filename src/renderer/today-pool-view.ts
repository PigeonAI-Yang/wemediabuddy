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
  | { kind: 'demotion'; text: string };

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

export function poolBadgeClass(badge: PoolBadge): string {
  if (badge.kind === 'new') return 'pool-new';
  if (badge.kind === 'timeliness') return `pool-${badge.tone}`;
  if (badge.kind === 'demotion') return 'pool-demotion';
  return 'gray';
}

export function poolBadges(item: PoolItemLike, nowMs: number): PoolBadge[] {
  const badges: PoolBadge[] = [];
  if (item.isNew) badges.push({ kind: 'new', text: '新' });
  badges.push({ kind: 'timeliness', text: CLASS_LABELS[item.timelinessClass], tone: item.timelinessClass });
  if (item.expiresAt) {
    const remainMs = Date.parse(item.expiresAt) - nowMs;
    if (remainMs > 0) {
      const hours = Math.floor(remainMs / 3_600_000);
      badges.push({ kind: 'expiry', text: hours >= 1 ? `还剩 ~${hours}h` : `还剩 ~${Math.max(1, Math.round(remainMs / 60_000))}m` });
    }
  }
  if (item.demotion) badges.push({ kind: 'demotion', text: '刚发布过同主题' });
  return badges;
}
