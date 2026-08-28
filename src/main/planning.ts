import { broadcastDataChanged } from './data-changed.ts';
import { normalizeTitle } from './ferment-read.ts';
import { PROPAGATION_CRITERIA, sameThesis } from '../shared/propagation.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { linkTopicSources } from './knowledge.ts';
import { wakePersistentKnowledgeJobs } from './knowledge-compile-trigger.ts';
import { isExactZhihuFallback } from './planning-stage.ts';

export type PlanItemInput = { title: string; priority: number; whyNow: string; timeliness: string; targetAudience: string; angle: string; pointOfView: string; platforms: string[]; formats: string[]; titleGuidance: string; openingGuidance: string; structureGuidance: string; effortEstimate: string; sourceIds: string[]; availableMaterials?: string[]; missingMaterials?: string[]; reviewIds?: string[]; methodFindingIds?: string[]; topicId?: string; scoreReasons?: unknown };
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

const SCORE_CRITERIA: Record<string, number> = PROPAGATION_CRITERIA;

function parseMaybeJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function validateScoredReasons(value: unknown): string[] {
  if (value === undefined || value === null) return ['scoreReasons_required'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['scoreReasons_invalid'];
  const score = value as { status?: unknown; score?: unknown; reasons?: unknown };
  const errors: string[] = [];
  if (score.status === 'pending') errors.push('score_pending_not_allowed');
  else if (score.status !== 'scored') errors.push('score_status_must_be_scored');
  if (typeof score.score !== 'number' || !Number.isFinite(score.score) || score.score < 0 || score.score > 100) errors.push('score_range_0_100');
  if (!Array.isArray(score.reasons)) return [...errors, 'score_reasons_six_required'];
  const seen = new Set<string>();
  let total = 0;
  for (const reason of score.reasons as Array<{ criterion?: unknown; weight?: unknown; score?: unknown }>) {
    const expectedWeight = SCORE_CRITERIA[String(reason?.criterion)];
    if (expectedWeight === undefined || seen.has(String(reason?.criterion))) {
      errors.push('score_reasons_criteria_invalid');
      continue;
    }
    seen.add(String(reason.criterion));
    if (reason.weight !== expectedWeight || typeof reason.score !== 'number' || !Number.isFinite(reason.score) || (reason.score as number) < 0 || (reason.score as number) > expectedWeight) errors.push('score_reason_value_invalid');
    else total += reason.score as number;
  }
  if (seen.size !== 6 || (score.reasons as unknown[]).length !== 6) errors.push('score_reasons_six_required');
  if (typeof score.score === 'number' && Number.isFinite(score.score) && total !== score.score) errors.push('score_total_mismatch');
  return [...new Set(errors)];
}

function pendingScoreReasonsJson(): string {
  const reasons = [
    { criterion: 'reader_immediacy_benefit', weight: 20, score: 0, reason: 'insufficient_evidence' },
    { criterion: 'tension_curiosity_gap', weight: 20, score: 0, reason: 'insufficient_evidence' },
    { criterion: 'why_now_window', weight: 20, score: 0, reason: 'insufficient_evidence' },
    { criterion: 'save_share_comment_motive', weight: 20, score: 0, reason: 'insufficient_evidence' },
    { criterion: 'evidence_credibility', weight: 15, score: 0, reason: 'insufficient_evidence' },
    { criterion: 'account_fit', weight: 5, score: 0, reason: 'insufficient_evidence' },
  ];
  return JSON.stringify({ status: 'pending', score: 0, reasons, pending_reason: 'insufficient_evidence' });
}

function scoredJsonForItem(item: PlanItemInput): { json: string; status: 'draft' | 'ready_for_review' } {
  const raw = (item as Record<string, unknown>).scoreReasons ?? (item as Record<string, unknown>).score_reasons ?? (item as Record<string, unknown>).score_reasons_json;
  if (raw === undefined || raw === null) {
    return { json: pendingScoreReasonsJson(), status: 'draft' };
  }
  const parsed = parseMaybeJson(raw);
  const errors = validateScoredReasons(parsed);
  if (errors.length) throw Object.assign(new Error(`validation_failed: ${errors.join('; ')}`), { code: 'validation_failed', errors });
  return { json: JSON.stringify(parsed), status: 'ready_for_review' };
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
  for (const item of input.items) {
    if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 7) throw new Error('机会等级必须是 0–7 的整数。');
    if (!item.sourceIds.length) throw new Error('计划条目必须引用资料。');
    if (isExactZhihuFallback(item as Parameters<typeof isExactZhihuFallback>[0])) {
      throw Object.assign(new Error('validation_failed: exact_zhihu_fallback_template'), { code: 'validation_failed', errors: ['exact_zhihu_fallback_template'] });
    }
  }
  // Thesis diversity — same normalized core claim/reader job even with different titles (intra-batch)
  if (input.items.length > 1) {
    const dupes: Array<{ pair: [number, number]; reason: string }> = [];
    for (let i = 0; i < input.items.length; i += 1) {
      for (let j = i + 1; j < input.items.length; j += 1) {
        const a = input.items[i];
        const b = input.items[j];
        if (sameThesis(
          { pointOfView: a.pointOfView ?? '', angle: a.angle ?? '', targetAudience: a.targetAudience ?? '' },
          { pointOfView: b.pointOfView ?? '', angle: b.angle ?? '', targetAudience: b.targetAudience ?? '' }
        )) {
          dupes.push({ pair: [i, j], reason: `thesis_duplicate: item ${i} "${a.title.slice(0, 32)}" ↔ item ${j} "${b.title.slice(0, 32)}" share normalized POV/angle/audience` });
        }
      }
    }
    if (dupes.length) {
      const msg = `thesis_not_diverse: ${dupes.length} duplicate thesis pair(s): ${dupes.map((d) => `[${d.pair[0]}↔${d.pair[1]}]`).join(', ')}. ` + dupes[0].reason;
      throw Object.assign(new Error(`validation_failed: ${msg}`), { code: 'validation_failed', errors: dupes.map((d) => d.reason), dupes });
    }
  }
  // Thesis diversity across active persistent topics (existing approved theses)
  if (input.items.length > 0) {
    const existingTheses = database.prepare(`
      SELECT pi.point_of_view AS pov, pi.angle AS angle, pi.target_audience AS audience
      FROM topics t
      JOIN plan_items pi ON pi.topic_id = t.id
      WHERE t.status IN ('active','watching') AND pi.planning_status = 'approved'
      GROUP BY t.id
    `).all() as Array<{ pov: string; angle: string; audience: string }>;
    const dedupExisting = new Map<string, { pointOfView: string; angle: string; targetAudience: string }>();
    for (const row of existingTheses) {
      const key = `${row.pov}|${row.angle}|${row.audience}`;
      if (!dedupExisting.has(key)) dedupExisting.set(key, { pointOfView: row.pov ?? '', angle: row.angle ?? '', targetAudience: row.audience ?? '' });
    }
    const crossDupes: Array<{ index: number; reason: string }> = [];
    for (let i = 0; i < input.items.length; i += 1) {
      const cur = input.items[i];
      for (const [key, existing] of dedupExisting.entries()) {
        if (sameThesis(
          { pointOfView: cur.pointOfView ?? '', angle: cur.angle ?? '', targetAudience: cur.targetAudience ?? '' },
          existing
        )) {
          crossDupes.push({ index: i, reason: `thesis_duplicate_with_active_topic: item ${i} "${cur.title.slice(0, 32)}" duplicates active topic thesis "${key.slice(0, 48)}"` });
          break;
        }
      }
    }
    if (crossDupes.length) {
      const msg = `thesis_not_diverse_with_active: ${crossDupes.length} item(s) duplicate active persistent thesis: ${crossDupes.map((d) => `[${d.index}]`).join(', ')}. ` + crossDupes[0].reason;
      throw Object.assign(new Error(`validation_failed: ${msg}`), { code: 'validation_failed', errors: crossDupes.map((d) => d.reason), dupes: crossDupes });
    }
  }
  const items = input.items.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)
    .map(({ item }) => item);
  const sourceIds = input.items.flatMap((item) => item.sourceIds);
  if (sourceIds.length) {
    const sourceCount = Number((database.prepare(`SELECT COUNT(*) AS count FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')})`).get(...sourceIds) as { count: number }).count);
    if (sourceCount !== new Set(sourceIds).size) throw new Error('计划引用了不存在的资料。');
    const withoutUrl = Number((database.prepare(`SELECT COUNT(*) AS count FROM source_items WHERE id IN (${sourceIds.map(() => '?').join(',')}) AND (canonical_url IS NULL OR canonical_url = '')`).get(...sourceIds) as { count: number }).count);
    if (withoutUrl > 0) throw new Error('计划引用的资料缺少可追溯链接；深挖发现的材料必须带原始 URL 入库后才能引用。');
  }
  const hasCoverageContract = input.candidateSources !== undefined || input.sourceDecisions !== undefined;
  const decisions = input.sourceDecisions ?? [];
  const candidates = input.candidateSources ?? [];
  if (hasCoverageContract) {
    if (!input.candidateSources || !input.sourceDecisions) throw new Error('PLAN_SOURCE_COVERAGE_CONTRACT_REQUIRED');
    const candidateById = new Map<string, number>();
    for (const candidate of candidates) {
      if (!candidate.sourceId || !Number.isInteger(candidate.sourceRevision) || candidate.sourceRevision < 1) throw new Error('PLAN_SOURCE_CANDIDATE_INVALID');
      if (candidateById.has(candidate.sourceId)) throw new Error('PLAN_SOURCE_CANDIDATE_DUPLICATE');
      candidateById.set(candidate.sourceId, candidate.sourceRevision);
      const current = database.prepare('SELECT revision FROM source_items WHERE id=?').get(candidate.sourceId) as { revision: number } | undefined;
      if (!current || current.revision !== candidate.sourceRevision) throw new Error('PLAN_SOURCE_CANDIDATE_STALE');
    }
    const decisionKeys = new Set<string>();
    const selectedIds = new Set(sourceIds);
    for (const decision of decisions) {
      if (decisionKeys.has(decision.sourceId)) throw new Error('PLAN_SOURCE_DECISION_DUPLICATE');
      decisionKeys.add(decision.sourceId);
      const frozenRevision = candidateById.get(decision.sourceId);
      if (!frozenRevision || (decision.sourceRevision !== undefined && decision.sourceRevision !== frozenRevision)) throw new Error('PLAN_SOURCE_DECISION_OUT_OF_SCOPE');
      if (!decision.reasonCode.trim() || !decision.reason.trim()) throw new Error('PLAN_SOURCE_DECISION_REASON_REQUIRED');
      if ((decision.decision === 'selected') !== selectedIds.has(decision.sourceId)) throw new Error('PLAN_SOURCE_SELECTION_MISMATCH');
    }
    if (candidateById.size !== decisionKeys.size || [...candidateById.keys()].some((sourceId) => !decisionKeys.has(sourceId))) {
      throw new Error('PLAN_SOURCE_COVERAGE_INCOMPLETE');
    }
    if ([...selectedIds].some((sourceId) => !candidateById.has(sourceId))) {
      throw new Error('PLAN_SOURCE_SELECTION_OUT_OF_SCOPE');
    }
  }
  validateReferences(database, 'topics', input.items.flatMap((item) => item.topicId ? [item.topicId] : []), '计划引用了不存在的主题。');
  validateReferences(database, 'reviews', input.items.flatMap((item) => item.reviewIds ?? []), '计划引用了不存在的复盘。', "status='final'");
  const now = new Date().toISOString(); const id = randomUUID();
  const inserted: Array<{ planItemId: string; item: PlanItemInput }> = [];
  if (transaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE plans SET is_current = 0, updated_at = ?, revision = revision + 1 WHERE plan_date = ? AND is_current = 1').run(now, input.planDate);
    database.prepare('INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(id, input.planDate, input.timezone, input.summary, now, now);
    items.forEach((item, sortOrder) => {
      const planItemId = randomUUID();
      const { json: scoreReasonsJson, status: planningStatus } = scoredJsonForItem(item);
      const provenanceJson = JSON.stringify({ origin: 'daily_judge', transitions: [{ from: null, to: planningStatus, by: 'system', at: now }], fingerprints: { template_exact_9fields: false } });
      database.prepare(`INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision, score_reasons_json, planning_status, planning_provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(planItemId, id, item.topicId ?? null, item.title, item.priority, item.whyNow, item.timeliness, item.targetAudience, item.angle, item.pointOfView, JSON.stringify(item.platforms), JSON.stringify(item.formats), item.titleGuidance, item.openingGuidance, item.structureGuidance, item.effortEstimate, JSON.stringify(item.sourceIds), JSON.stringify(item.availableMaterials ?? []), JSON.stringify(item.missingMaterials ?? []), JSON.stringify(item.reviewIds ?? []), JSON.stringify(item.methodFindingIds ?? []), sortOrder, now, now, scoreReasonsJson, planningStatus, provenanceJson);
      if (item.topicId) linkTopicSources(database, item.topicId, item.sourceIds, now);
      inserted.push({ planItemId, item });
    });
    if (hasCoverageContract) {
      const planItemBySource = new Map<string, string>();
      for (const row of inserted) {
        for (const sourceId of row.item.sourceIds) if (!planItemBySource.has(sourceId)) planItemBySource.set(sourceId, row.planItemId);
      }
      const insertDecision = database.prepare(`INSERT INTO plan_source_decisions
        (plan_id,source_id,source_revision,decision,reason_code,reason,plan_item_id,created_at)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const decision of decisions) {
        insertDecision.run(id, decision.sourceId, decision.sourceRevision ?? candidates.find((candidate) => candidate.sourceId === decision.sourceId)!.sourceRevision, decision.decision,
          decision.reasonCode.trim(), decision.reason.trim(), decision.decision === 'selected' ? planItemBySource.get(decision.sourceId) ?? null : null, now);
      }
    }
    if (transaction) database.exec('COMMIT');
  } catch (error) { if (transaction) database.exec('ROLLBACK'); throw error; }
  if (transaction) wakePersistentKnowledgeJobs();
  broadcastDataChanged({ scopes: ['today'], reason: 'plan.save' });
  return { id, revision: 1 };
}

function validateReferences(database: DatabaseSync, table: 'topics' | 'reviews' | 'method_findings', ids: string[], message: string, extra = '1=1') {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const count = Number((database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${extra} AND id IN (${unique.map(() => '?').join(',')})`).get(...unique) as { count: number }).count);
  if (count !== unique.length) throw new Error(message);
}
