import type { DatabaseSync } from 'node:sqlite';
import { classifyTimeliness, fingerprintPlanItem, setCarryState, TIMELINESS_WINDOW_HOURS, type TimelinessClass, type WorkCarryItem } from './ferment.ts';
import { listXPostTrends, type XPostTrend } from './x-post-metrics.ts';
import {
  parseSourceIds,
  type OpportunityPoolItem
} from './workbench.ts';
import { readManagerAdapterProjection, type ManagerAdapterReadModel } from './workspace-orchestrator-manager-adapter.ts';
import type { RecommendationReasonCode } from '../shared/propagation.ts';

export type ProposalTab = 'today' | 'shelved' | 'adopted' | 'dismissed' | 'expired' | 'scoring_pending';

export type ProposalLedgerItem = {
  planItemId: string;
  planDate: string;
  createdAt: string;
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
  state: ProposalTab;
  carry: { id: string; state: string; revision: number; reason: string | null } | null;
  adoptedProjectId: string | null;
  isNew: boolean;
  planningStatus: string;
  revision: number;
  planningProvenanceJson: string | null;
  scoreReasonsJson: string | null;
  repairReasonCode?: RecommendationReasonCode;
  repairReason?: string;
  scoreSnapshot?: null | {
    total: number;
    audienceFit: number;
    viewpointRoom: number;
    evidenceAvailability: number;
    timelinessLifecycle: number;
    articleVideoTransfer: number;
    executionCost: number;
    risks: readonly string[];
    hardRiskCodes?: readonly string[];
    route?: string;
    proposalReason?: string;
    dimensionEvidence?: Record<string, { evidence?: string; reason?: string }>;
    duplicate?: boolean;
  };
};

export type ProposalLedgerCounts = {
  today: number;
  shelved: number;
  adopted: number;
  dismissed: number;
  expired: number;
  scoring_pending: number;
};

export type ProposalLedgerResult = {
  tab: ProposalTab;
  items: ProposalLedgerItem[];
  total: number;
  hasMore: boolean;
  counts: ProposalLedgerCounts;
  /** Durable roots used for this date; an empty list means legacy projection is still applicable. */
  orchestrator: ManagerAdapterReadModel;
};

export type ProposalLedgerInput = {
  planDate: string;
  tab?: ProposalTab;
  limit?: number;
  offset?: number;
  now?: Date;
};

export type ProposalDetail = {
  item: ProposalLedgerItem;
  sources: Array<{ id: string; title: string; author: string | null; url: string; publishedAt: string | null; verificationStatus: string; revision: number }>;
  score: { status?: string; score?: number; reasons?: Array<{ criterion: string; weight: number; score: number; reason?: string }> } | null;
  sourceDecisions: Array<{ sourceId: string; sourceRevision: number; decision: string; reasonCode: string; reason: string }>;
  evidenceGaps: Array<{ code?: string; statement?: string }>;
};

type CarryRow = { id: string; state: string; revision: number; reason: string | null };
type LedgerRow = {
  planItemId: string; title: string; priority: number; timeliness: string | null; topicId: string | null;
  whyNow: string; angle: string; pointOfView: string; sourceIds: string; createdAt: string; planDate: string;
  targetAudience: string; platforms: string; formats: string; titleGuidance: string; openingGuidance: string;
  structureGuidance: string; effortEstimate: string; availableMaterials: string; missingMaterials: string;
  planningStatus: string; revision: number; planningProvenanceJson: string | null; scoreReasonsJson: string | null;
};
type Disposition = {
  state: 'adopted' | 'dismissed' | 'expired' | 'open';
  carry: CarryRow | null;
  adoptedProjectId: string | null;
  expiresAt: string | null;
  timelinessClass: TimelinessClass;
};

function emptyCounts(): ProposalLedgerCounts {
  return { today: 0, shelved: 0, adopted: 0, dismissed: 0, expired: 0, scoring_pending: 0 };
}

function findAdoptedProjectId(database: DatabaseSync, planItemId: string): string | null {
  const byPlan = database.prepare(
    `SELECT id FROM content_projects WHERE plan_item_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`
  ).get(planItemId);
  if (byPlan && typeof byPlan === 'object' && 'id' in byPlan && typeof byPlan.id === 'string') return byPlan.id;
  return null;
}

function readCarryRow(value: unknown): CarryRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.state !== 'string' || typeof row.revision !== 'number') return null;
  return {
    id: row.id,
    state: row.state,
    revision: row.revision,
    reason: typeof row.reason === 'string' ? row.reason : null
  };
}

function dispositionOfPlanItem(
  database: DatabaseSync,
  input: {
    planItemId: string;
    title: string;
    topicId: string | null;
    sourceIds: string[];
    timeliness: string | null;
    createdAt: string;
  },
  now: Date,
  carryByFingerprint: Map<string, CarryRow>
): Disposition {
  const timelinessClass = classifyTimeliness(input.timeliness);
  const windowHours = TIMELINESS_WINDOW_HOURS[timelinessClass];
  const expiresAt = windowHours === null ? null : new Date(Date.parse(input.createdAt) + windowHours * 3_600_000).toISOString();
  const fingerprint = fingerprintPlanItem({ title: input.title, topicId: input.topicId, sourceIds: input.sourceIds });
  const carry = carryByFingerprint.get(fingerprint) ?? null;
  const adoptedProjectId = findAdoptedProjectId(database, input.planItemId);
  const hasProject = Boolean(adoptedProjectId);

  if (hasProject || carry?.state === 'done') {
    return {
      state: 'adopted',
      carry,
      adoptedProjectId,
      expiresAt,
      timelinessClass
    };
  }
  if (carry?.state === 'dismissed') {
    return { state: 'dismissed', carry, adoptedProjectId: null, expiresAt, timelinessClass };
  }
  if (carry?.state === 'expired' || (expiresAt && Date.parse(expiresAt) <= now.getTime())) {
    return { state: 'expired', carry, adoptedProjectId: null, expiresAt, timelinessClass };
  }
  return { state: 'open', carry, adoptedProjectId: null, expiresAt, timelinessClass };
}
function loadScoreSnapshotMap(database: DatabaseSync): Map<string, unknown> {
  const map = new Map<string, unknown>();
  try {
    const rows = database.prepare("SELECT source_item_id, score_snapshot_json FROM daily_content_targets WHERE source_item_id IS NOT NULL").all() as Array<{source_item_id:string; score_snapshot_json:string}>;
    for (const r of rows) { try { map.set(r.source_item_id, JSON.parse(r.score_snapshot_json)); } catch {} }
  } catch {}
  return map;
}
function enrichItemsWithScore(database: DatabaseSync, items: ProposalLedgerItem[]): void {
  const scoreBySource = loadScoreSnapshotMap(database);
  for (const it of items) {
    for (const sid of it.sourceIds) { const v = scoreBySource.get(sid); if (v) { (it as unknown as Record<string, unknown>).scoreSnapshot = v; break; } }
  }
}


function loadCarryMap(database: DatabaseSync): Map<string, CarryRow> {
  const map = new Map<string, CarryRow>();
  const rows = database.prepare(
    `SELECT fingerprint, id, state, revision, reason FROM work_carry_items WHERE object_type='plan_item'`
  ).all();
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row.fingerprint !== 'string') continue;
    const carry = readCarryRow(row);
    if (carry) map.set(row.fingerprint, carry);
  }
  return map;
}
function fetchAllLedgerRows(database: DatabaseSync): LedgerRow[] {
  return database.prepare(`
    SELECT pi.id AS planItemId, pi.title, pi.priority, pi.timeliness, pi.topic_id AS topicId,
      pi.why_now AS whyNow, pi.angle, pi.point_of_view AS pointOfView, pi.source_ids_json AS sourceIds,
      pi.target_audience AS targetAudience, pi.platforms_json AS platforms, pi.formats_json AS formats,
      pi.title_guidance AS titleGuidance, pi.opening_guidance AS openingGuidance,
      pi.structure_guidance AS structureGuidance, pi.effort_estimate AS effortEstimate,
      pi.available_materials_json AS availableMaterials, pi.missing_materials_json AS missingMaterials,
      pi.created_at AS createdAt, p.plan_date AS planDate,
      pi.planning_status AS planningStatus, pi.revision AS revision,
      pi.planning_provenance_json AS planningProvenanceJson, pi.score_reasons_json AS scoreReasonsJson
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
  `).all() as LedgerRow[];
}
function fetchLedgerRowsByIds(database: DatabaseSync, planItemIds: readonly string[]): LedgerRow[] {
  const ids = [...new Set(planItemIds.filter((id) => typeof id === 'string' && id.trim()))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return database.prepare(`
    SELECT pi.id AS planItemId, pi.title, pi.priority, pi.timeliness, pi.topic_id AS topicId,
      pi.why_now AS whyNow, pi.angle, pi.point_of_view AS pointOfView, pi.source_ids_json AS sourceIds,
      pi.target_audience AS targetAudience, pi.platforms_json AS platforms, pi.formats_json AS formats,
      pi.title_guidance AS titleGuidance, pi.opening_guidance AS openingGuidance,
      pi.structure_guidance AS structureGuidance, pi.effort_estimate AS effortEstimate,
      pi.available_materials_json AS availableMaterials, pi.missing_materials_json AS missingMaterials,
      pi.created_at AS createdAt, p.plan_date AS planDate,
      pi.planning_status AS planningStatus, pi.revision AS revision,
      pi.planning_provenance_json AS planningProvenanceJson, pi.score_reasons_json AS scoreReasonsJson
    FROM plan_items pi
    JOIN plans p ON p.id = pi.plan_id
    WHERE pi.id IN (${placeholders})
  `).all(...ids) as LedgerRow[];
}

function opportunityFromLedgerRow(database: DatabaseSync, row: LedgerRow, now: Date): OpportunityPoolItem {
  const sourceIds = parseSourceIds(row.sourceIds);
  const timelinessClass = classifyTimeliness(row.timeliness);
  const windowHours = TIMELINESS_WINDOW_HOURS[timelinessClass];
  const createdMs = Date.parse(row.createdAt);
  const expiresAt = windowHours === null || !Number.isFinite(createdMs)
    ? null
    : new Date(createdMs + windowHours * 3_600_000).toISOString();
  return {
    planItemId: row.planItemId, planDate: row.planDate, title: row.title, priority: row.priority,
    timeliness: row.timeliness, timelinessClass, expiresAt, topicId: row.topicId, sourceIds,
    whyNow: row.whyNow, angle: row.angle, pointOfView: row.pointOfView, targetAudience: row.targetAudience,
    platforms: parseSourceIds(row.platforms), formats: parseSourceIds(row.formats),
    titleGuidance: row.titleGuidance, openingGuidance: row.openingGuidance,
    structureGuidance: row.structureGuidance, effortEstimate: row.effortEstimate,
    availableMaterials: parseSourceIds(row.availableMaterials), missingMaterials: parseSourceIds(row.missingMaterials),
    trendEvidence: listXPostTrends(database, { sourceIds }), createdAt: row.createdAt,
    isNew: Number.isFinite(createdMs) && createdMs >= now.getTime() - 6 * 3_600_000,
    planningStatus: row.planningStatus, revision: row.revision,
    planningProvenanceJson: row.planningProvenanceJson, scoreReasonsJson: row.scoreReasonsJson,
    carry: null, demotion: null
  };
}

function buildProposalLedger(
  database: DatabaseSync,
  input: ProposalLedgerInput,
  withDetails: boolean
): ProposalLedgerResult {
  const now = input.now ?? new Date();
  const tab = input.tab ?? 'today';
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const rows = fetchAllLedgerRows(database);
  const rowById = new Map(rows.map((row) => [row.planItemId, row]));
  const orchestrator = readManagerAdapterProjection(database, { businessDate: input.planDate });
  const carryByFingerprint = loadCarryMap(database);
  const openRows = rows.filter((row) => dispositionOfPlanItem(
    database,
    {
      planItemId: row.planItemId,
      title: row.title,
      topicId: row.topicId,
      sourceIds: parseSourceIds(row.sourceIds),
      timeliness: row.timeliness,
      createdAt: row.createdAt
    },
    now,
    carryByFingerprint
  ).state === 'open');
  // The persisted plan is the user-facing truth. A ready_for_review row is
  // immediately approvable; stale orchestration projections and optional
  // guidance fields must not demote it back into a repair queue.
  const openItems = openRows
    .filter((row) => row.planningStatus === 'ready_for_review')
    .map((row) => opportunityFromLedgerRow(database, row, now));
  const repairable = openRows
    .filter((row) => row.planningStatus === 'draft' || row.planningStatus === 'rejected')
    .map((row) => ({
      planItemId: row.planItemId,
      revision: row.revision,
      reasonCode: 'score_pending' as const,
      reason: row.planningStatus === 'rejected' ? '已驳回，等待重新策划' : '方案尚未完成，等待继续策划'
    }));
  const counts = emptyCounts();
  const terminalItems: ProposalLedgerItem[] = [];
  counts.today = openItems.filter((item) => item.planDate === input.planDate).length;
  counts.shelved = openItems.filter((item) => item.planDate !== input.planDate).length;
  counts.scoring_pending = repairable.length;

  for (const row of rows) {
    const sourceIds = parseSourceIds(row.sourceIds);
    const disposition = dispositionOfPlanItem(
      database,
      {
        planItemId: row.planItemId,
        title: row.title,
        topicId: row.topicId,
        sourceIds,
        timeliness: row.timeliness,
        createdAt: row.createdAt
      },
      now,
      carryByFingerprint
    );

    if (disposition.state !== 'open') {
      const state: ProposalTab = disposition.state;
      counts[state] += 1;
      if (!withDetails) continue;
      if (state !== tab) continue;
      terminalItems.push({
        planItemId: row.planItemId,
        planDate: row.planDate,
        createdAt: row.createdAt,
        title: row.title,
        priority: row.priority,
        timeliness: row.timeliness,
        timelinessClass: disposition.timelinessClass,
        expiresAt: disposition.expiresAt,
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
        trendEvidence: [],
        state,
        carry: disposition.carry,
        adoptedProjectId: disposition.adoptedProjectId,
        isNew: false,
        planningStatus: row.planningStatus,
        revision: row.revision,
        planningProvenanceJson: row.planningProvenanceJson,
        scoreReasonsJson: row.scoreReasonsJson
      });
      continue;
    }

  }

  if (!withDetails) {
    return { tab, items: [], total: counts[tab], hasMore: false, counts, orchestrator };
  }

  if (tab === 'today' || tab === 'shelved') {
    const filtered = openItems.filter((item) => (tab === 'today' ? item.planDate === input.planDate : item.planDate < input.planDate));
    const items: ProposalLedgerItem[] = filtered.slice(offset, offset + limit).map((item) => {
      return {
      planItemId: item.planItemId,
      planDate: item.planDate,
      createdAt: item.createdAt,
      title: item.title,
      priority: item.priority,
      timeliness: item.timeliness,
      timelinessClass: item.timelinessClass,
      expiresAt: item.expiresAt,
      topicId: item.topicId,
      sourceIds: item.sourceIds,
      whyNow: item.whyNow,
      angle: item.angle,
      pointOfView: item.pointOfView,
      targetAudience: item.targetAudience,
      platforms: item.platforms,
      formats: item.formats,
      titleGuidance: item.titleGuidance,
      openingGuidance: item.openingGuidance,
      structureGuidance: item.structureGuidance,
      effortEstimate: item.effortEstimate,
      availableMaterials: item.availableMaterials,
      missingMaterials: item.missingMaterials,
      trendEvidence: item.trendEvidence,
      state: tab,
      carry: item.carry ? { ...item.carry, reason: null } : null,
      adoptedProjectId: null,
      isNew: item.isNew,
      planningStatus: item.planningStatus ?? 'draft',
      revision: item.revision ?? 1,
      planningProvenanceJson: item.planningProvenanceJson,
      scoreReasonsJson: item.scoreReasonsJson
    };});
    enrichItemsWithScore(database, items);
    return { tab, items, total: filtered.length, hasMore: offset + items.length < filtered.length, counts, orchestrator };
  }

  if (tab === 'scoring_pending') {
    const repairItems = repairable.flatMap((repair) => {
      const row = rowById.get(repair.planItemId);
      return row ? [{ repair, item: opportunityFromLedgerRow(database, row, now) }] : [];
    });
    const items: ProposalLedgerItem[] = repairItems.slice(offset, offset + limit).map(({ item, repair }) => {
      return {
        planItemId: item.planItemId,
        planDate: item.planDate,
        createdAt: item.createdAt,
        title: item.title,
        priority: item.priority,
        timeliness: item.timeliness,
        timelinessClass: item.timelinessClass,
        expiresAt: item.expiresAt,
        topicId: item.topicId,
        sourceIds: item.sourceIds,
        whyNow: item.whyNow,
        angle: item.angle,
        pointOfView: item.pointOfView,
        targetAudience: item.targetAudience,
        platforms: item.platforms,
        formats: item.formats,
        titleGuidance: item.titleGuidance,
        openingGuidance: item.openingGuidance,
        structureGuidance: item.structureGuidance,
        effortEstimate: item.effortEstimate,
        availableMaterials: item.availableMaterials,
        missingMaterials: item.missingMaterials,
        trendEvidence: item.trendEvidence,
        state: tab,
        carry: item.carry ? { ...item.carry, reason: null } : null,
        adoptedProjectId: null,
        isNew: item.isNew,
        planningStatus: item.planningStatus ?? 'draft',
        revision: item.revision ?? 1,
        planningProvenanceJson: item.planningProvenanceJson,
        scoreReasonsJson: item.scoreReasonsJson,
        repairReasonCode: repair.reasonCode,
        repairReason: repair.reason
      };
    });
    enrichItemsWithScore(database, items);
    return { tab, items, total: repairItems.length, hasMore: offset + items.length < repairItems.length, counts, orchestrator };
  }
  terminalItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.priority - b.priority);
  const pageItems = terminalItems.slice(offset, offset + limit);
  enrichItemsWithScore(database, pageItems);
  return {
    tab,
    items: pageItems,
    total: counts[tab],
    hasMore: offset + pageItems.length < counts[tab],
    counts,
    orchestrator
  };

}

export function getProposalLedger(database: DatabaseSync, input: ProposalLedgerInput): ProposalLedgerResult {
  return buildProposalLedger(database, input, true);
}

export function getProposalDetail(database: DatabaseSync, planItemId: string): ProposalDetail | null {
  const ledger = buildProposalLedger(database, { planDate: '0000-00-00', tab: 'adopted', limit: 2000 }, true);
  const all = fetchAllLedgerRows(database).find((row) => row.planItemId === planItemId);
  if (!all) return null;
  const page = buildProposalLedger(database, { planDate: all.planDate, tab: 'today', limit: 2000 }, true);
  const terminalTabs: ProposalTab[] = ['shelved', 'adopted', 'dismissed', 'expired', 'scoring_pending'];
  const item = page.items.find((entry) => entry.planItemId === planItemId)
    ?? terminalTabs.flatMap((tab) => buildProposalLedger(database, { planDate: all.planDate, tab, limit: 2000 }, true).items).find((entry) => entry.planItemId === planItemId);
  void ledger;
  if (!item) return null;
  const sourceIds = item.sourceIds;
  const sources = sourceIds.length ? database.prepare(`SELECT id,title,author,canonical_url AS url,published_at AS publishedAt,
    verification_status AS verificationStatus,revision FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')}) ORDER BY collected_at ASC`).all(...sourceIds) as ProposalDetail['sources'] : [];
  const sourceDecisions = database.prepare(`SELECT source_id AS sourceId,source_revision AS sourceRevision,decision,
    reason_code AS reasonCode,reason FROM plan_source_decisions WHERE plan_id=(SELECT plan_id FROM plan_items WHERE id=?) ORDER BY created_at,source_id`).all(planItemId) as ProposalDetail['sourceDecisions'];
  let score: ProposalDetail['score'] = null;
  try { score = JSON.parse(item.scoreReasonsJson || 'null'); } catch { score = null; }
  const evidenceGaps: ProposalDetail['evidenceGaps'] = [];
  const jobs = database.prepare("SELECT payload_json AS payloadJson FROM jobs WHERE kind='knowledge_reactivate_sources' AND status='succeeded' ORDER BY finished_at DESC LIMIT 100").all() as Array<{ payloadJson: string }>;
  for (const row of jobs) {
    try {
      const payload = JSON.parse(row.payloadJson) as { sourceId?: string; currentSourceId?: string; evidenceGaps?: ProposalDetail['evidenceGaps'] };
      if ((sourceIds.includes(payload.sourceId ?? '') || sourceIds.includes(payload.currentSourceId ?? '')) && Array.isArray(payload.evidenceGaps)) evidenceGaps.push(...payload.evidenceGaps);
    } catch { /* malformed historical job is ignored */ }
  }
  return { item, sources, score, sourceDecisions, evidenceGaps };
}

export function summarizeProposalLedger(
  database: DatabaseSync,
  input: { planDate: string; now?: Date }
): ProposalLedgerCounts {
  return buildProposalLedger(database, { planDate: input.planDate, now: input.now, tab: 'today' }, true).counts;
}

/** Restore a dismissed proposal (carry → active) so it can reappear in open tabs. */
export function restoreDismissedProposal(
  database: DatabaseSync,
  input: { planItemId: string; reason?: string },
  broadcast = false
): WorkCarryItem {
  const item = database.prepare(
    `SELECT id, title, topic_id AS topicId, source_ids_json AS sourceIds FROM plan_items WHERE id = ?`
  ).get(input.planItemId) as { id: string; title: string; topicId: string | null; sourceIds: string } | undefined;
  if (!item) throw Object.assign(new Error('选题不存在。'), { code: 'NOT_FOUND' });
  const sourceIds = parseSourceIds(item.sourceIds);
  const fingerprint = fingerprintPlanItem({
    title: item.title,
    topicId: item.topicId,
    sourceIds
  });
  const carry = database.prepare(
    `SELECT id, revision FROM work_carry_items
     WHERE state = 'dismissed' AND (
       (object_type = 'plan_item' AND object_id = ?) OR fingerprint = ?
     )
     ORDER BY updated_at DESC LIMIT 1`
  ).get(input.planItemId, fingerprint) as { id: string; revision: number } | undefined;
  if (!carry) throw Object.assign(new Error('没有可恢复的否掉记录。'), { code: 'NOT_RESTORABLE' });
  return setCarryState(database, {
    id: carry.id,
    expectedRevision: carry.revision,
    state: 'active',
    reason: input.reason ?? '从选题台账恢复'
  }, broadcast);
}
