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

export type ProposalTab = 'today' | 'shelved' | 'adopted' | 'dismissed' | 'expired';

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
};

export type ProposalLedgerCounts = {
  today: number;
  shelved: number;
  adopted: number;
  dismissed: number;
  expired: number;
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

type CarryRow = { id: string; state: string; revision: number; reason: string | null };
type Disposition = {
  state: 'adopted' | 'dismissed' | 'expired' | 'open';
  carry: CarryRow | null;
  adoptedProjectId: string | null;
  expiresAt: string | null;
  timelinessClass: TimelinessClass;
};

function emptyCounts(): ProposalLedgerCounts {
  return { today: 0, shelved: 0, adopted: 0, dismissed: 0, expired: 0 };
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

function buildProposalLedger(
  database: DatabaseSync,
  input: ProposalLedgerInput,
  withDetails: boolean
): ProposalLedgerResult {
  const now = input.now ?? new Date();
  const tab = input.tab ?? 'today';
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const rows = latestPlanItemRowsByDate(database, 2000);
  const carryByFingerprint = loadCarryMap(database);
  const counts = emptyCounts();
  const openItems: OpportunityPoolItem[] = [];
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

    const state: ProposalTab = disposition.state === 'open'
      ? (row.planDate === input.planDate ? 'today' : 'shelved')
      : disposition.state;
    counts[state] += 1;
    if (!withDetails) continue;

    if (disposition.state === 'open') {
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
        carry: disposition.carry
          ? { id: disposition.carry.id, state: disposition.carry.state, revision: disposition.carry.revision }
          : null,
        demotion: null
      });
      continue;
    }

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
      isNew: false
    });
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
    const items: ProposalLedgerItem[] = filtered.slice(offset, offset + limit).map((item) => ({
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
      isNew: item.isNew
    }));
    return { tab, items, total: filtered.length, hasMore: offset + items.length < filtered.length, counts };
  }

  terminalItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.priority - b.priority);
  const pageItems = terminalItems.slice(offset, offset + limit);
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
