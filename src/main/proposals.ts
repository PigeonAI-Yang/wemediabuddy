import type { DatabaseSync } from 'node:sqlite';
import { classifyTimeliness, fingerprintPlanItem, setCarryState, TIMELINESS_WINDOW_HOURS, type TimelinessClass, type WorkCarryItem } from './ferment.ts';
import { hasProjectForPlanItemOrSources } from './ferment-read.ts';
import { listXPostTrends, type XPostTrend } from './x-post-metrics.ts';
import {
  dedupeOpenProposals,
  latestPlanItemRowsByDate,
  parseSourceIds,
  type OpportunityPoolItem
} from './workbench.ts';
import { isScoredReadyForReview, isScoringPending } from '../shared/propagation.ts';

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

function findAdoptedProjectId(database: DatabaseSync, planItemId: string, sourceIds: string[]): string | null {
  const byPlan = database.prepare(
    `SELECT id FROM content_projects WHERE plan_item_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`
  ).get(planItemId);
  if (byPlan && typeof byPlan === 'object' && 'id' in byPlan && typeof byPlan.id === 'string') return byPlan.id;
  if (!sourceIds.length) return null;
  const bySource = database.prepare(`
    SELECT cp.id AS id FROM content_project_sources cps
    JOIN content_projects cp ON cp.id = cps.project_id
    WHERE cp.archived_at IS NULL AND cps.source_id IN (${sourceIds.map(() => '?').join(',')})
    ORDER BY cp.updated_at DESC LIMIT 1
  `).get(...sourceIds);
  if (bySource && typeof bySource === 'object' && 'id' in bySource && typeof bySource.id === 'string') return bySource.id;
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
  const adoptedProjectId = findAdoptedProjectId(database, input.planItemId, input.sourceIds);
  const hasProject = Boolean(adoptedProjectId) || hasProjectForPlanItemOrSources(database, input.planItemId, input.sourceIds);

  if (hasProject || carry?.state === 'done') {
    return {
      state: 'adopted',
      carry,
      adoptedProjectId: adoptedProjectId ?? findAdoptedProjectId(database, input.planItemId, input.sourceIds),
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
function fetchAllLedgerRows(database: DatabaseSync, limit = 2000): Array<{
  planItemId: string; title: string; priority: number; timeliness: string | null; topicId: string | null;
  whyNow: string; angle: string; pointOfView: string; sourceIds: string; createdAt: string; planDate: string;
  targetAudience: string; platforms: string; formats: string; titleGuidance: string; openingGuidance: string;
  structureGuidance: string; effortEstimate: string; availableMaterials: string; missingMaterials: string;
  planningStatus: string; revision: number; planningProvenanceJson: string | null; scoreReasonsJson: string | null;
}> {
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
    LIMIT ?
  `).all(limit) as Array<{
    planItemId: string; title: string; priority: number; timeliness: string | null; topicId: string | null;
    whyNow: string; angle: string; pointOfView: string; sourceIds: string; createdAt: string; planDate: string;
    targetAudience: string; platforms: string; formats: string; titleGuidance: string; openingGuidance: string;
    structureGuidance: string; effortEstimate: string; availableMaterials: string; missingMaterials: string;
    planningStatus: string; revision: number; planningProvenanceJson: string | null; scoreReasonsJson: string | null;
  }>;
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
  const rows = fetchAllLedgerRows(database, 2000);
  const carryByFingerprint = loadCarryMap(database);
  const counts = emptyCounts();
  const openItems: OpportunityPoolItem[] = [];
  const pendingScoringItems: OpportunityPoolItem[] = [];
  const terminalItems: ProposalLedgerItem[] = [];
  const newHours = 6;

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

    // Open disposition: split by scoring eligibility (SSOT)
    const checkItem = { planning_status: row.planningStatus, score_reasons_json: row.scoreReasonsJson } as unknown;
    const eligible = isScoredReadyForReview(checkItem);
    const pending = isScoringPending(checkItem);
    if (eligible) {
      const state: ProposalTab = row.planDate === input.planDate ? 'today' : 'shelved';
      counts[state] += 1;
      if (!withDetails) continue;
      openItems.push({
        planItemId: row.planItemId,
        planDate: row.planDate,
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
        trendEvidence: listXPostTrends(database, { sourceIds }),
        createdAt: row.createdAt,
        isNew: Date.parse(row.createdAt) >= now.getTime() - newHours * 3_600_000,
        planningStatus: row.planningStatus,
        revision: row.revision,
        planningProvenanceJson: row.planningProvenanceJson,
        scoreReasonsJson: row.scoreReasonsJson,
        carry: disposition.carry
          ? { id: disposition.carry!.id, state: disposition.carry!.state, revision: disposition.carry!.revision }
          : null,
        demotion: null
      });
      (openItems[openItems.length - 1] as unknown as Record<string, unknown>).__planningStatus = row.planningStatus;
      (openItems[openItems.length - 1] as unknown as Record<string, unknown>).__revision = row.revision;
      (openItems[openItems.length - 1] as unknown as Record<string, unknown>).__provenance = row.planningProvenanceJson;
      (openItems[openItems.length - 1] as unknown as Record<string, unknown>).__score = row.scoreReasonsJson;
      continue;
      pendingScoringItems.push({
        planItemId: row.planItemId,
        planDate: row.planDate,
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
        trendEvidence: listXPostTrends(database, { sourceIds }),
        createdAt: row.createdAt,
        isNew: Date.parse(row.createdAt) >= now.getTime() - newHours * 3_600_000,
        planningStatus: row.planningStatus,
        revision: row.revision,
        planningProvenanceJson: row.planningProvenanceJson,
        scoreReasonsJson: row.scoreReasonsJson,
        carry: disposition.carry
          ? { id: disposition.carry!.id, state: disposition.carry!.state, revision: disposition.carry!.revision }
          : null,
        demotion: null
      });
      (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__planningStatus = row.planningStatus;
      (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__revision = row.revision;
      (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__provenance = row.planningProvenanceJson;
      (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__score = row.scoreReasonsJson;
      continue;
    }
    // Fallback open but neither eligible nor pending (should not happen): treat as pending for honesty
    counts.scoring_pending += 1;
    if (!withDetails) continue;
    pendingScoringItems.push({
      planItemId: row.planItemId,
      planDate: row.planDate,
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
      trendEvidence: listXPostTrends(database, { sourceIds }),
      createdAt: row.createdAt,
      isNew: Date.parse(row.createdAt) >= now.getTime() - newHours * 3_600_000,
      planningStatus: row.planningStatus,
      revision: row.revision,
      planningProvenanceJson: row.planningProvenanceJson,
      scoreReasonsJson: row.scoreReasonsJson,
      carry: disposition.carry
        ? { id: disposition.carry!.id, state: disposition.carry!.state, revision: disposition.carry!.revision }
        : null,
      demotion: null
    });
    (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__planningStatus = row.planningStatus;
    (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__revision = row.revision;
    (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__provenance = row.planningProvenanceJson;
    (pendingScoringItems[pendingScoringItems.length - 1] as unknown as Record<string, unknown>).__score = row.scoreReasonsJson;
  }

  if (!withDetails) {
    return { tab, items: [], total: counts[tab], hasMore: false, counts };
  }

  if (tab === 'today' || tab === 'shelved') {
    const deduped = dedupeOpenProposals(openItems);
    let todayCount = 0;
    let shelvedCount = 0;
    for (const item of deduped) {
      if (item.planDate === input.planDate) todayCount += 1;
      else shelvedCount += 1;
    }
    counts.today = todayCount;
    counts.shelved = shelvedCount;
    const filtered = deduped.filter((item) => (tab === 'today' ? item.planDate === input.planDate : item.planDate < input.planDate));
    const items: ProposalLedgerItem[] = filtered.slice(offset, offset + limit).map((item) => {
      const meta = item as unknown as Record<string, unknown>;
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
      planningStatus: String(meta.__planningStatus ?? 'draft'),
      revision: Number(meta.__revision ?? 1),
      planningProvenanceJson: (meta.__provenance as string | null) ?? null,
      scoreReasonsJson: (meta.__score as string | null) ?? null
    };});
    enrichItemsWithScore(database, items);
    return { tab, items, total: filtered.length, hasMore: offset + items.length < filtered.length, counts };
  }

  if (tab === 'scoring_pending') {
    const deduped = dedupeOpenProposals(pendingScoringItems);
    // Truthful count for scoring_pending is deduped length (avoid story duplicate inflating)
    counts.scoring_pending = deduped.length;
    const filtered = deduped.filter((item) => item.planDate === input.planDate);
    // If current date has pending, show those; otherwise show all pending
    const itemsSource = filtered.length ? filtered : deduped;
    const items: ProposalLedgerItem[] = itemsSource.slice(offset, offset + limit).map((item) => {
      const meta = item as unknown as Record<string, unknown>;
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
        planningStatus: String(meta.__planningStatus ?? 'draft'),
        revision: Number(meta.__revision ?? 1),
        planningProvenanceJson: (meta.__provenance as string | null) ?? null,
        scoreReasonsJson: (meta.__score as string | null) ?? null
      };
    });
    enrichItemsWithScore(database, items);
    return { tab, items, total: itemsSource.length, hasMore: offset + items.length < itemsSource.length, counts };
  }

  terminalItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.priority - b.priority);
  const pageItems = terminalItems.slice(offset, offset + limit);
  enrichItemsWithScore(database, pageItems);
  return {
    tab,
    items: pageItems,
    total: counts[tab],
    hasMore: offset + pageItems.length < counts[tab],
    counts
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
