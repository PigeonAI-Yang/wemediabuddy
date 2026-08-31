import { DatabaseSync } from 'node:sqlite';
import { classifyRecommendationItem, type RecommendationReasonCode } from '../shared/propagation.ts';
import { classifyTimeliness, fingerprintPlanItem, TIMELINESS_WINDOW_HOURS } from './ferment.ts';
import { sameStory } from './ferment-read.ts';
import { listXPostTrends } from './x-post-metrics.ts';
import type { OpportunityPoolItem } from './workbench.ts';

export type TodayRecommendationProjection = {
  primary: OpportunityPoolItem | null;
  eligible: OpportunityPoolItem[];
  counts: { todayReady: number; carriedReady: number; scoringPending: number; invalid: number };
  repairable: Array<{ planItemId: string; revision: number; reasonCode: RecommendationReasonCode; reason: string }>;
  context: { businessDate: string; asOf: string };
  emptyReason: 'has_recommendation' | 'run_active' | 'scoring_active' | 'scoring_incomplete' | 'invalid_needs_repair' | 'clean_empty' | 'not_started';
};

type Row = {
  planItemId: string; planDate: string; title: string; priority: number; sortOrder: number;
  timeliness: string | null; topicId: string | null; sourceIds: string; whyNow: string;
  angle: string; pointOfView: string; targetAudience: string; platforms: string; formats: string;
  titleGuidance: string; openingGuidance: string; structureGuidance: string; effortEstimate: string;
  availableMaterials: string; missingMaterials: string; reviewIds: string; methodFindingIds: string;
  createdAt: string; planningStatus: string | null; revision: number; planningProvenanceJson: string | null;
  scoreReasonsJson: string | null;
};

function parseArray(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())) : [];
  } catch { return []; }
}

function latestRows(database: DatabaseSync, businessDate: string): Row[] {
  return database.prepare(`
    WITH ranked_plans AS (
      SELECT id, plan_date,
        ROW_NUMBER() OVER (PARTITION BY plan_date ORDER BY created_at DESC, id DESC) AS rank
      FROM plans
      WHERE plan_date <= ? AND EXISTS (SELECT 1 FROM plan_items WHERE plan_id = plans.id)
    )
    SELECT pi.id AS planItemId, rp.plan_date AS planDate, pi.title, pi.priority,
      pi.sort_order AS sortOrder, pi.timeliness, pi.topic_id AS topicId,
      pi.source_ids_json AS sourceIds, pi.why_now AS whyNow, pi.angle,
      pi.point_of_view AS pointOfView, pi.target_audience AS targetAudience,
      pi.platforms_json AS platforms, pi.formats_json AS formats,
      pi.title_guidance AS titleGuidance, pi.opening_guidance AS openingGuidance,
      pi.structure_guidance AS structureGuidance, pi.effort_estimate AS effortEstimate,
      pi.available_materials_json AS availableMaterials, pi.missing_materials_json AS missingMaterials,
      pi.review_ids_json AS reviewIds, pi.method_finding_ids_json AS methodFindingIds,
      pi.created_at AS createdAt, pi.planning_status AS planningStatus, pi.revision,
      pi.planning_provenance_json AS planningProvenanceJson, pi.score_reasons_json AS scoreReasonsJson
    FROM ranked_plans rp JOIN plan_items pi ON pi.plan_id = rp.id
    WHERE rp.rank = 1
  `).all(businessDate) as Row[];
}

export function buildTodayRecommendationProjection(
  database: DatabaseSync,
  businessDate: string,
  options: { now?: Date } = {}
): TodayRecommendationProjection {
  const asOf = options.now ?? new Date();
  const counts = { todayReady: 0, carriedReady: 0, scoringPending: 0, invalid: 0 };
  const repairable: TodayRecommendationProjection['repairable'] = [];
  const candidates: Array<{ item: OpportunityPoolItem; score: number; sortOrder: number }> = [];
  const projectByItem = database.prepare('SELECT id FROM content_projects WHERE plan_item_id = ? AND archived_at IS NULL LIMIT 1');
  const carryByItem = database.prepare("SELECT id, state, revision FROM work_carry_items WHERE object_type='plan_item' AND object_id=? ORDER BY updated_at DESC LIMIT 1");
  const carryByFingerprint = database.prepare("SELECT id, state, revision FROM work_carry_items WHERE object_type='plan_item' AND fingerprint=? ORDER BY updated_at DESC LIMIT 1");
  const sourceExists = database.prepare('SELECT COUNT(*) AS count FROM source_items WHERE id = ?');
  const publicationSince = new Date(asOf.getTime() - 24 * 3_600_000).toISOString();
  const publicationByTopic = new Map<string, { publishedAt: string; platform: string }>();
  for (const published of database.prepare(`
    SELECT cp.topic_id AS topicId, p.platform, p.published_at AS publishedAt
    FROM publications p
    JOIN platform_versions pv ON pv.id = p.platform_version_id
    JOIN content_projects cp ON cp.id = pv.project_id
    WHERE p.status = 'published' AND p.published_at IS NOT NULL
      AND p.published_at >= ? AND cp.topic_id IS NOT NULL
    ORDER BY p.published_at DESC
  `).all(publicationSince) as Array<{ topicId: string; platform: string; publishedAt: string }>) {
    if (!publicationByTopic.has(published.topicId)) {
      publicationByTopic.set(published.topicId, { publishedAt: published.publishedAt, platform: published.platform });
    }
  }

  for (const row of latestRows(database, businessDate)) {
    if (projectByItem.get(row.planItemId)) continue;
    const sourceIds = parseArray(row.sourceIds);
    const fingerprint = fingerprintPlanItem({ title: row.title, topicId: row.topicId, sourceIds });
    const carry = (carryByItem.get(row.planItemId) ?? carryByFingerprint.get(fingerprint)) as { id: string; state: string; revision: number } | undefined;
    if (carry && ['done', 'dismissed', 'expired'].includes(carry.state)) continue;

    const createdMs = Date.parse(row.createdAt);
    if (!Number.isFinite(createdMs)) {
      counts.invalid += 1;
      repairable.push({ planItemId: row.planItemId, revision: row.revision, reasonCode: 'proposal_incomplete', reason: 'created_at 无法解析' });
      continue;
    }
    const timelinessClass = classifyTimeliness(row.timeliness);
    const windowHours = TIMELINESS_WINDOW_HOURS[timelinessClass];
    const expiresAt = windowHours === null ? null : new Date(createdMs + windowHours * 3_600_000).toISOString();
    if (expiresAt && Date.parse(expiresAt) <= asOf.getTime()) continue;

    const qualification = classifyRecommendationItem({ ...row, plan_date: row.planDate }, { businessDate, asOf });
    if (qualification.kind === 'pending') {
      counts.scoringPending += 1;
      repairable.push({ planItemId: row.planItemId, revision: row.revision, reasonCode: qualification.reasonCode, reason: qualification.reason });
      continue;
    }
    if (qualification.kind === 'invalid' || sourceIds.some((id) => Number((sourceExists.get(id) as { count: number }).count) !== 1)) {
      counts.invalid += 1;
      repairable.push({
        planItemId: row.planItemId,
        revision: row.revision,
        reasonCode: qualification.kind === 'invalid' ? qualification.reasonCode : 'proposal_incomplete',
        reason: qualification.kind === 'invalid' ? qualification.reason : 'sourceIds 包含无法读回的资料'
      });
      continue;
    }

    const item: OpportunityPoolItem = {
      planItemId: row.planItemId, planDate: row.planDate, title: row.title, priority: row.priority,
      timeliness: row.timeliness, timelinessClass, expiresAt, topicId: row.topicId, sourceIds,
      whyNow: row.whyNow, angle: row.angle, pointOfView: row.pointOfView, targetAudience: row.targetAudience,
      platforms: parseArray(row.platforms), formats: parseArray(row.formats), titleGuidance: row.titleGuidance,
      openingGuidance: row.openingGuidance, structureGuidance: row.structureGuidance,
      effortEstimate: row.effortEstimate, availableMaterials: parseArray(row.availableMaterials),
      missingMaterials: parseArray(row.missingMaterials), trendEvidence: listXPostTrends(database, { sourceIds }),
      createdAt: row.createdAt, isNew: createdMs >= asOf.getTime() - 6 * 3_600_000,
      planningStatus: row.planningStatus, revision: row.revision,
      planningProvenanceJson: row.planningProvenanceJson, scoreReasonsJson: row.scoreReasonsJson,
      carry: carry ? { id: carry.id, state: carry.state, revision: carry.revision } : null,
      demotion: row.topicId ? publicationByTopic.get(row.topicId) ?? null : null
    };
    candidates.push({ item, score: qualification.score, sortOrder: row.sortOrder });
  }

  candidates.sort((a, b) => b.score - a.score
    || b.item.planDate.localeCompare(a.item.planDate)
    || a.item.priority - b.item.priority
    || a.sortOrder - b.sortOrder
    || a.item.planItemId.localeCompare(b.item.planItemId));
  const eligible: OpportunityPoolItem[] = [];
  for (const candidate of candidates) {
    if (!eligible.some((keeper) => sameStory(keeper, candidate.item))) eligible.push(candidate.item);
  }
  for (const item of eligible) {
    if (item.planDate === businessDate) counts.todayReady += 1;
    else counts.carriedReady += 1;
  }
  const primary = eligible[0] ?? null;
  const emptyReason: TodayRecommendationProjection['emptyReason'] = primary
    ? 'has_recommendation'
    : counts.scoringPending ? 'scoring_incomplete'
    : counts.invalid ? 'invalid_needs_repair'
    : 'clean_empty';
  return { primary, eligible, counts, repairable, context: { businessDate, asOf: asOf.toISOString() }, emptyReason };
}
