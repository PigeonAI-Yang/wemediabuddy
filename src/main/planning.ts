import { broadcastDataChanged } from './data-changed.ts';
import { normalizeTitle } from './ferment-read.ts';
import type { EditorialDecision } from '../shared/editorial-thesis.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { linkTopicSources } from './knowledge.ts';
import { wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';
import { validatePlanSourceReferences, validateTruthGateSourceReferences } from './planning-stage.ts';


export type PlanItemInput = { title: string; priority: number; whyNow: string; timeliness: string; targetAudience: string; angle: string; pointOfView: string; platforms: string[]; formats: string[]; titleGuidance: string; openingGuidance: string; structureGuidance: string; effortEstimate: string; sourceIds: string[]; availableMaterials?: string[]; missingMaterials?: string[]; reviewIds?: string[]; methodFindingIds?: string[]; topicId?: string; scoreReasons?: unknown; editorialDecision?: EditorialDecision | unknown };
export type PlanSourceDecision = {
  sourceId: string;
  sourceRevision?: number;
  decision: 'selected' | 'excluded' | 'unresolved' | 'blocked';
  reasonCode: string;
  reason: string;
};
export type SavePlanInput = {
  planDate: string;
  timezone: string;
  summary: string;
  items: PlanItemInput[];
  candidateSources?: Array<{ sourceId: string; sourceRevision: number }>;
  sourceDecisions?: PlanSourceDecision[];
};


function rawScoreForItem(item: PlanItemInput): unknown {
  return (item as Record<string, unknown>).scoreReasons ?? (item as Record<string, unknown>).score_reasons ?? (item as Record<string, unknown>).score_reasons_json;
}

function scoredJsonForItem(item: PlanItemInput): { json: string; status: 'ready_for_review' } {
  const raw = rawScoreForItem(item);
  return { json: JSON.stringify(raw ?? {}), status: 'ready_for_review' };
}
function sourceIdsForPlanItem(item: PlanItemInput): string[] {
  const record = item as unknown as Record<string, unknown>;
  const raw = record.sourceIds ?? record.source_ids ?? record.source_ids_json;
  if (Array.isArray(raw)) return [...new Set(raw.map(String).filter(Boolean))];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return [...new Set(parsed.map(String).filter(Boolean))];
    } catch {}
  }
  return [];
}


export function createTopic(database: DatabaseSync, title: string): { id: string; revision: number } {
  const id = randomUUID();
  const now = new Date().toISOString();
  const trimmed = title.trim().slice(0, 80) || '未命名主题';
  const canonicalKey = normalizeTitle(trimmed) || id;
  database.prepare(`INSERT INTO topics
    (id, title, created_at, updated_at, revision, canonical_key, kind, summary, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, 1, ?, 'theme', NULL, 'active', ?, ?)`).run(id, trimmed, now, now, canonicalKey, now, now);
  return { id, revision: 1 };
}

export function saveCurrentPlan(database: DatabaseSync, input: SavePlanInput, transaction = true): { id: string; revision: number } {
  const items = input.items.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)
    .map(({ item }) => item);
  const normalizedItems = items.map((item) => ({ item, sourceIds: sourceIdsForPlanItem(item) }));
  for (const { item, sourceIds } of normalizedItems) {
    validatePlanSourceReferences(database, sourceIds);
    validateTruthGateSourceReferences(database, rawScoreForItem(item), sourceIds);
  }

  const candidates = input.candidateSources ?? [];
  const decisions = input.sourceDecisions ?? [];
  if (candidates.length || decisions.length) {
    const candidateKeys = new Set(candidates.map((entry) => `${entry.sourceId}\u0000${entry.sourceRevision}`));
    const decisionKeys = new Set(decisions.map((entry) => {
      const revision = entry.sourceRevision ?? candidates.find((candidate) => candidate.sourceId === entry.sourceId)?.sourceRevision;
      return `${entry.sourceId}\u0000${revision ?? ''}`;
    }));
    if (candidateKeys.size !== candidates.length || decisionKeys.size !== decisions.length || candidateKeys.size !== decisionKeys.size || [...candidateKeys].some((key) => !decisionKeys.has(key))) {
      throw new Error('PLAN_SOURCE_COVERAGE_INCOMPLETE');
    }
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const selectedPlanItems = new Map<string, string>();
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE plans SET is_current = 0, updated_at = ?, revision = revision + 1 WHERE plan_date = ? AND is_current = 1').run(now, input.planDate);
    database.prepare('INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(id, input.planDate, input.timezone, input.summary, now, now);
    normalizedItems.forEach(({ item, sourceIds }, sortOrder) => {
      const planItemId = randomUUID();
      const { json: scoreReasonsJson, status: planningStatus } = scoredJsonForItem(item);
      const provenanceJson = JSON.stringify({ origin: 'daily_judge', transitions: [{ from: null, to: planningStatus, by: 'system', at: now }], fingerprints: { template_exact_9fields: false }, ...(item.editorialDecision ? { editorial_decision: item.editorialDecision } : {}) });
      database.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision, score_reasons_json, planning_status, planning_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(planItemId, id, item.topicId ?? null, item.title, item.priority, item.whyNow, item.timeliness, item.targetAudience, item.angle, item.pointOfView, JSON.stringify(item.platforms), JSON.stringify(item.formats), item.titleGuidance, item.openingGuidance, item.structureGuidance, item.effortEstimate, JSON.stringify(sourceIds), JSON.stringify(item.availableMaterials ?? []), JSON.stringify(item.missingMaterials ?? []), JSON.stringify(item.reviewIds ?? []), JSON.stringify(item.methodFindingIds ?? []), sortOrder, now, now, scoreReasonsJson, planningStatus, provenanceJson);
      for (const sourceId of sourceIds) if (!selectedPlanItems.has(sourceId)) selectedPlanItems.set(sourceId, planItemId);
      if (item.topicId) linkTopicSources(database, item.topicId, sourceIds, now);
    });
    if (decisions.length) {
      const candidateRevision = new Map(candidates.map((entry) => [entry.sourceId, entry.sourceRevision]));
      const readRevision = database.prepare('SELECT revision FROM source_items WHERE id=?');
      const insertDecision = database.prepare('INSERT INTO plan_source_decisions (plan_id,source_id,source_revision,decision,reason_code,reason,plan_item_id,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const decision of decisions) {
        const revision = decision.sourceRevision ?? candidateRevision.get(decision.sourceId) ?? Number((readRevision.get(decision.sourceId) as { revision?: number } | undefined)?.revision ?? 0);
        if (revision < 1) throw Object.assign(new Error('validation_failed: source_not_found'), { code: 'validation_failed', errors: ['source_not_found'] });
        const planItemId = decision.decision === 'selected' ? selectedPlanItems.get(decision.sourceId) ?? null : null;
        insertDecision.run(id, decision.sourceId, revision, decision.decision, decision.reasonCode, decision.reason, planItemId, now);
      }
    }
    if (transaction) database.exec('COMMIT');
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  }
  if (transaction) wakePersistentKnowledgeJobs();
  broadcastDataChanged({ scopes: ['today'], reason: 'plan.save' });
  return { id, revision: 1 };
}
