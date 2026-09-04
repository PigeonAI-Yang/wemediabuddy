import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PROPAGATION_V2_CRITERIA, parsePropagationScoreReasons, isValidPropagationV2Reasons, validateProposalCompleteness } from '../shared/propagation.ts';
import { validateEditorialDecision, type EditorialDecision } from '../shared/editorial-thesis.ts';

export type PlanningStatus = 'draft' | 'ready_for_review' | 'approved' | 'rejected';

export const PlanningStatus = {
  Draft: 'draft' as PlanningStatus,
  ReadyForReview: 'ready_for_review' as PlanningStatus,
  Approved: 'approved' as PlanningStatus,
  Rejected: 'rejected' as PlanningStatus,
} as const;

export const ZHIHU_FALLBACK_FINGERPRINT = {
  whyNow: '基于知乎热题的每日内容目标',
  timeliness: 'today',
  targetAudience: '泛科技受众',
  angle: '深度解读该问题的核心争议与证据',
  pointOfView: '提供独立判断与可操作建议',
  platforms: ['x', 'xiaohongshu', 'wechat'] as const,
  formats: ['article'] as const,
  openingGuidance: '以问题为引，快速建立共识再展开分析',
  structureGuidance: '背景→拆解→证据→观点→行动',
} as const;

export type ScoreReasonsInput = {
  status: 'pending' | 'scored';
  version?: 'propagation_v2';
  score: number;
  reasons?: Array<{ criterion: string; weight: number; score: number; reason?: string }>;
  pending_reason?: string;
  pendingReason?: string;
  [key: string]: any;
};

export type PlanItemReviewInput = {
  title?: string;
  priority?: number;
  whyNow?: string;
  why_now?: string;
  timeliness?: string;
  targetAudience?: string;
  target_audience?: string;
  angle?: string;
  pointOfView?: string;
  point_of_view?: string;
  platforms?: string[];
  platforms_json?: string;
  formats?: string[];
  formats_json?: string;
  titleGuidance?: string;
  title_guidance?: string;
  openingGuidance?: string;
  opening_guidance?: string;
  structureGuidance?: string;
  structure_guidance?: string;
  effortEstimate?: string;
  effort_estimate?: string;
  sourceIds?: string[];
  source_ids?: string[];
  source_ids_json?: string;
  availableMaterials?: string[];
  missingMaterials?: string[];
  available_materials_json?: string;
  missing_materials_json?: string;
  reviewIds?: string[];
  methodFindingIds?: string[];
  topicId?: string | null;
  topic_id?: string | null;
  scoreReasons?: ScoreReasonsInput | string;
  score_reasons?: ScoreReasonsInput | string;
  score_reasons_json?: string;
  editorialDecision?: EditorialDecision | unknown;
  editorial_decision?: EditorialDecision | unknown;
  [key: string]: any;
};

function parseMaybeJson(value: any): any {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}
function getStringField(item: any, ...keys: string[]): string | undefined {
  for (const k of keys) if (item[k] !== undefined && item[k] !== null) return String(item[k]);
  return undefined;
}
function getArrayField(item: any, ...names: string[]): string[] | undefined {
  for (const name of names) {
    if (Array.isArray(item[name])) return item[name];
    if (item[name] !== undefined) {
      const parsed = parseMaybeJson(item[name]);
      if (Array.isArray(parsed)) return parsed;
    }
  }
  return undefined;
}
const SCORE_CRITERIA = new Map<string, number>(Object.entries(PROPAGATION_V2_CRITERIA));

function readScoreReasons(item: PlanItemReviewInput): unknown {
  const raw = item.scoreReasons ?? item.score_reasons ?? item.score_reasons_json;
  return raw === undefined ? undefined : parseMaybeJson(raw);
}

function validateScoredReasons(value: unknown): string[] {
  if (value === undefined || value === null) return ['scoreReasons_required'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['scoreReasons_invalid'];
  const score = value as ScoreReasonsInput;
  const errors: string[] = [];
  if (score.status === 'pending') errors.push('score_pending_not_allowed');
  else if (score.status !== 'scored') errors.push('score_status_must_be_scored');
  if (score.version !== 'propagation_v2') errors.push('score_version_propagation_v2_required');
  if (typeof score.score !== 'number' || !Number.isFinite(score.score) || score.score < 0 || score.score > 100) errors.push('score_range_0_100');
  if (!Array.isArray(score.reasons)) return [...errors, 'score_reasons_six_required'];
  const seen = new Set<string>();
  let total = 0;
  for (const reason of score.reasons) {
    const expectedWeight = SCORE_CRITERIA.get(reason?.criterion);
    if (expectedWeight === undefined || seen.has(reason.criterion)) {
      errors.push('score_reasons_criteria_invalid');
      continue;
    }
    seen.add(reason.criterion);
    if (reason.weight !== expectedWeight || typeof reason.score !== 'number' || !Number.isFinite(reason.score) || reason.score < 0 || reason.score > expectedWeight) errors.push('score_reason_value_invalid');
    else total += reason.score;
  }
  if (seen.size !== 6 || score.reasons.length !== 6) errors.push('score_reasons_six_required');
  if (typeof score.score === 'number' && Number.isFinite(score.score) && total !== score.score) errors.push('score_total_mismatch');
  if (!isValidPropagationV2Reasons(parsePropagationScoreReasons(value))) errors.push('truth_gate_or_propagation_v2_invalid');
  return [...new Set(errors)];
}

export function validatePlanSourceReferences(database: DatabaseSync, sourceIds: string[]): void {
  const unique = [...new Set(sourceIds.filter(Boolean))];
  if (unique.length === 0) throw Object.assign(new Error('validation_failed: sourceIds_required'), { code: 'validation_failed', errors: ['sourceIds_required'] });
  const placeholders = unique.map(() => '?').join(',');
  const rows = database.prepare(`SELECT id, canonical_url, management_status FROM source_items WHERE id IN (${placeholders})`).all(...unique) as Array<{ id: string; canonical_url: string | null; management_status: string }>;
  if (rows.length !== unique.length) throw Object.assign(new Error('validation_failed: source_not_found'), { code: 'validation_failed', errors: ['source_not_found'] });
  if (rows.some((row) => !String(row.canonical_url ?? '').trim())) throw Object.assign(new Error('validation_failed: source_canonical_url_required'), { code: 'validation_failed', errors: ['source_canonical_url_required'] });
  if (rows.some((row) => row.management_status === 'archived')) throw Object.assign(new Error('validation_failed: source_unavailable'), { code: 'validation_failed', errors: ['source_unavailable'] });
}

export function validateTruthGateSourceReferences(database: DatabaseSync, rawScore: unknown, planSourceIds: string[]): void {
  const score = parsePropagationScoreReasons(rawScore);
  const claims = score?.truthGate?.claims;
  if (!Array.isArray(claims)) return;
  const sourceIds = [...new Set(planSourceIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))];
  validatePlanSourceReferences(database, sourceIds);
  const placeholders = sourceIds.map(() => '?').join(',');
  const rows = database.prepare(`SELECT id, canonical_url, management_status FROM source_items WHERE id IN (${placeholders})`).all(...sourceIds) as Array<{
    id: string; canonical_url: string | null; management_status: string;
  }>;
  if (rows.some((row) => row.management_status === 'archived')) {
    throw Object.assign(new Error('validation_failed: source_unavailable'), { code: 'validation_failed', errors: ['source_unavailable'] });
  }
  const allowed = new Set(sourceIds);
  const outsidePlan = claims.flatMap((claim) => claim.sourceIds ?? []).some((sourceId) => !allowed.has(sourceId));
  if (outsidePlan) {
    throw Object.assign(new Error('validation_failed: truth_gate_source_out_of_scope'), {
      code: 'validation_failed', errors: ['truth_gate_source_out_of_scope'],
    });
  }
}

export function validateEditorialKnowledgeRefs(database: DatabaseSync, raw: unknown, expectedWinnerThesis?: string): void {
  const decision = validateEditorialDecision(raw, expectedWinnerThesis);
  if (!decision.valid || !decision.value) {
    throw Object.assign(new Error(`validation_failed: ${decision.errors.join('; ')}`), { code: 'validation_failed', errors: decision.errors });
  }
  const receipt = decision.value.knowledgeContext;
  if (receipt.status === 'no_relevant_context') return;
  const invalid: string[] = [];
  for (const ref of receipt.contextRefs) {
    const parts = ref.split(':');
    try {
      if (parts[0] === 'wiki_page' && parts.length === 3) {
        const row = database.prepare('SELECT 1 FROM knowledge_wiki_page_versions WHERE page_id = ? AND id = ?').get(parts[1], parts[2]);
        if (!row) invalid.push(ref);
      } else if (parts[0] === 'knowledge_note' && parts.length === 3) {
        const row = database.prepare('SELECT 1 FROM knowledge_note_versions WHERE note_id = ? AND id = ?').get(parts[1], parts[2]);
        if (!row) invalid.push(ref);
      } else if (parts[0] === 'evidence' && parts.length === 2) {
        const row = database.prepare('SELECT 1 FROM knowledge_evidence_links WHERE id = ?').get(parts[1]);
        if (!row) invalid.push(ref);
      } else invalid.push(ref);
    } catch {
      invalid.push(ref);
    }
  }
  if (invalid.length) {
    throw Object.assign(new Error(`validation_failed: knowledge_context_ref_not_found: ${invalid.join(', ')}`), {
      code: 'validation_failed', errors: ['knowledge_context_ref_not_found'], invalidKnowledgeRefs: invalid,
    });
  }
}


export function isExactZhihuFallback(item: PlanItemReviewInput): boolean {
  if (!item || typeof item !== 'object') return false;
  const whyNow = getStringField(item, 'whyNow', 'why_now');
  const timeliness = getStringField(item, 'timeliness');
  const targetAudience = getStringField(item, 'targetAudience', 'target_audience');
  const angle = getStringField(item, 'angle');
  const pointOfView = getStringField(item, 'pointOfView', 'point_of_view');
  const openingGuidance = getStringField(item, 'openingGuidance', 'opening_guidance');
  const structureGuidance = getStringField(item, 'structureGuidance', 'structure_guidance');
  let platforms = getArrayField(item, 'platforms', 'platforms_json');
  let formats = getArrayField(item, 'formats', 'formats_json');
  if (!platforms && typeof (item as any).platforms_json === 'string') { try { platforms = JSON.parse((item as any).platforms_json); } catch {} }
  if (!formats && typeof (item as any).formats_json === 'string') { try { formats = JSON.parse((item as any).formats_json); } catch {} }
  if (whyNow !== ZHIHU_FALLBACK_FINGERPRINT.whyNow) return false;
  if (timeliness !== ZHIHU_FALLBACK_FINGERPRINT.timeliness) return false;
  if (targetAudience !== ZHIHU_FALLBACK_FINGERPRINT.targetAudience) return false;
  if (angle !== ZHIHU_FALLBACK_FINGERPRINT.angle) return false;
  if (pointOfView !== ZHIHU_FALLBACK_FINGERPRINT.pointOfView) return false;
  if (!Array.isArray(platforms) || platforms.length !== ZHIHU_FALLBACK_FINGERPRINT.platforms.length) return false;
  for (let i = 0; i < platforms.length; i++) if (platforms[i] !== ZHIHU_FALLBACK_FINGERPRINT.platforms[i]) return false;
  if (!Array.isArray(formats) || formats.length !== ZHIHU_FALLBACK_FINGERPRINT.formats.length) return false;
  for (let i = 0; i < formats.length; i++) if (formats[i] !== ZHIHU_FALLBACK_FINGERPRINT.formats[i]) return false;
  if (openingGuidance !== ZHIHU_FALLBACK_FINGERPRINT.openingGuidance) return false;
  if (structureGuidance !== ZHIHU_FALLBACK_FINGERPRINT.structureGuidance) return false;
  return true;
}

export function validatePlanItemForReview(item: PlanItemReviewInput): { valid: boolean; errors: string[]; isFallback: boolean } {
  const errors: string[] = [];
  if (!item || typeof item !== 'object') return { valid: false, errors: ['invalid_input'], isFallback: false };
  const isFallback = isExactZhihuFallback(item);
  if (isFallback) errors.push('exact_zhihu_fallback_template');
  const title = String(item.title ?? '').trim();
  if (!title) errors.push('title_required');
  else if (title.length < 10 || title.length > 80) errors.push('title_length_10_80');
  const whyNow = String(item.whyNow ?? (item as any).why_now ?? '').trim();
  if (!whyNow) errors.push('whyNow_required');
  const timeliness = String(item.timeliness ?? '').trim();
  if (!timeliness) errors.push('timeliness_required');
  const targetAudience = String(item.targetAudience ?? (item as any).target_audience ?? '').trim();
  if (!targetAudience) errors.push('targetAudience_required');
  const angle = String(item.angle ?? '').trim();
  if (!angle) errors.push('angle_required');
  const pointOfView = String(item.pointOfView ?? (item as any).point_of_view ?? '').trim();
  if (!pointOfView) errors.push('pointOfView_required');
  const openingGuidance = String(item.openingGuidance ?? (item as any).opening_guidance ?? '').trim();
  if (!openingGuidance) errors.push('openingGuidance_required');
  const structureGuidance = String(item.structureGuidance ?? (item as any).structure_guidance ?? '').trim();
  if (!structureGuidance) errors.push('structureGuidance_required');
  let platforms: any = (item as any).platforms;
  if (platforms === undefined && (item as any).platforms_json !== undefined) { try { platforms = JSON.parse((item as any).platforms_json); } catch { platforms = undefined; } }
  let formats: any = (item as any).formats;
  if (formats === undefined && (item as any).formats_json !== undefined) { try { formats = JSON.parse((item as any).formats_json); } catch { formats = undefined; } }
  if (!Array.isArray(platforms) || platforms.length === 0) errors.push('platforms_required');
  if (!Array.isArray(formats) || formats.length === 0) errors.push('formats_required');
  let sourceIds: any = (item as any).sourceIds ?? (item as any).source_ids;
  if (sourceIds === undefined && (item as any).source_ids_json !== undefined) { try { sourceIds = JSON.parse((item as any).source_ids_json); } catch { sourceIds = undefined; } }
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) errors.push('sourceIds_required');
  if ((item as any).availableMaterials !== undefined && !Array.isArray((item as any).availableMaterials)) errors.push('availableMaterials_must_be_array');
  if ((item as any).missingMaterials !== undefined && !Array.isArray((item as any).missingMaterials)) errors.push('missingMaterials_must_be_array');
  const scoreReasons = readScoreReasons(item);
  errors.push(...validateScoredReasons(scoreReasons));
  const editorial = validateEditorialDecision(item.editorialDecision ?? item.editorial_decision, pointOfView);
  errors.push(...editorial.errors);
  errors.push(...validateProposalCompleteness(item).errors);
  return { valid: errors.length === 0, errors: [...new Set(errors)], isFallback };
}

function nowIso(): string { return new Date().toISOString(); }

function buildProvenanceForCreate(origin: string, sourceIds: string[]): string {
  const now = nowIso();
  return JSON.stringify({
    origin: origin || 'system',
    fingerprints: { template_exact_9fields: false, zhihu_hot_ids: sourceIds || [] },
    transitions: [{ from: null, to: 'draft', by: 'system', at: now, reason: 'stage_c_insufficient_evidence_pending' }],
  });
}
function appendProvenance(existingJson: string | null | undefined, transition: { from: string | null; to: PlanningStatus; by: string; at: string; reason?: string }, extraPatch?: any): string {
  let base: any = {};
  if (existingJson) { try { base = JSON.parse(existingJson); } catch { base = {}; } }
  if (!base.origin) base.origin = 'system';
  if (!Array.isArray(base.transitions)) base.transitions = [];
  base.transitions = [...base.transitions, transition];
  if (extraPatch) for (const [k, v] of Object.entries(extraPatch)) base[k] = v;
  if (!base.fingerprints) base.fingerprints = { template_exact_9fields: false };
  return JSON.stringify(base);
}
function getPendingScoreReasons(): string {
  const reasons = [
    { criterion: 'reality_change_significance', weight: 25, score: 0, reason: 'no_source_body_or_claims' },
    { criterion: 'tension_curiosity_gap', weight: 20, score: 0, reason: 'today_but_no_source_evidence' },
    { criterion: 'audience_stakes', weight: 20, score: 0 },
    { criterion: 'why_now_window', weight: 15, score: 0 },
    { criterion: 'one_sentence_relayability', weight: 15, score: 0 },
    { criterion: 'account_fit', weight: 5, score: 0 },
  ];
  return JSON.stringify({ status: 'pending', version: 'propagation_v2', score: 0, reasons, truthGate: { status: 'research_required', reason: 'insufficient_evidence', claims: [] }, pending_reason: 'insufficient_evidence' });
}

export function createPlanningDraftFromTarget(
  database: DatabaseSync,
  input: { title: string; sourceIds: string[]; planId?: string; topicId?: string | null; origin?: string; availableMaterials?: string[]; missingMaterials?: string[]; planDate?: string; timezone?: string }
): { planItemId: string; revision: number; planningStatus: PlanningStatus } {
  if (!input.title || !String(input.title).trim()) throw Object.assign(new Error('title_required'), { code: 'validation_failed' });
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0) throw Object.assign(new Error('sourceIds_required'), { code: 'validation_failed' });
  validatePlanSourceReferences(database, input.sourceIds);
  const now = nowIso();
  const title = String(input.title).trim().slice(0, 80) || '未命名策划';
  const sourceIds = [...new Set(input.sourceIds.filter(Boolean))];
  const availableMaterials = input.availableMaterials ?? [];
  const missingMaterials = input.missingMaterials ?? [];
  let planId = input.planId ?? null;
  const planDate = input.planDate ?? new Date().toISOString().slice(0, 10);
  const timezone = input.timezone ?? 'Asia/Shanghai';
  if (!planId) {
    const existing = database.prepare('SELECT id FROM plans WHERE plan_date = ? AND is_current = 1').get(planDate) as { id: string } | undefined;
    if (existing) planId = existing.id;
    else {
      planId = randomUUID();
      try { database.prepare('UPDATE plans SET is_current = 0, updated_at = ?, revision = revision + 1 WHERE plan_date = ? AND is_current = 1').run(now, planDate); } catch {}
      database.prepare('INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(planId, planDate, timezone, 'draft auto', now, now);
    }
  } else {
    const exists = database.prepare('SELECT id FROM plans WHERE id = ?').get(planId) as { id: string } | undefined;
    if (!exists) database.prepare('INSERT INTO plans (id, plan_date, timezone, summary, is_current, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1, ?, ?, 1)').run(planId, planDate, timezone, 'draft auto', now, now);
  }
  const planItemId = randomUUID();
  const maxRow = database.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM plan_items WHERE plan_id = ?').get(planId) as { m: number } | undefined;
  const sortOrder = Number(maxRow?.m ?? -1) + 1;
  const provenanceJson = buildProvenanceForCreate(input.origin ?? 'system', sourceIds);
  const pendingScoreJson = getPendingScoreReasons();
  const whyNow = '';
  const timeliness = '';
  const targetAudience = '';
  const angle = '';
  const pointOfView = '';
  const platformsJson = JSON.stringify([]);
  const formatsJson = JSON.stringify([]);
  const titleGuidance = '';
  const openingGuidance = '';
  const structureGuidance = '';
  const effortEstimate = '';
  const sourceIdsJson = JSON.stringify(sourceIds);
  const availableMaterialsJson = JSON.stringify(availableMaterials);
  const missingMaterialsJson = JSON.stringify(missingMaterials);
  const reviewIdsJson = JSON.stringify([]);
  const methodFindingIdsJson = JSON.stringify([]);
  let started = false;
  try { database.exec('BEGIN IMMEDIATE'); started = true; } catch { started = false; }
  try {
    database.prepare(
      `INSERT INTO plan_items (id, plan_id, topic_id, title, priority, why_now, timeliness, target_audience, angle, point_of_view, platforms_json, formats_json, title_guidance, opening_guidance, structure_guidance, effort_estimate, source_ids_json, available_materials_json, missing_materials_json, review_ids_json, method_finding_ids_json, sort_order, created_at, updated_at, revision, planning_status, planning_provenance_json, score_reasons_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(planItemId, planId, input.topicId ?? null, title, 0, whyNow, timeliness, targetAudience, angle, pointOfView, platformsJson, formatsJson, titleGuidance, openingGuidance, structureGuidance, effortEstimate, sourceIdsJson, availableMaterialsJson, missingMaterialsJson, reviewIdsJson, methodFindingIdsJson, sortOrder, now, now, 'draft', provenanceJson, pendingScoreJson);
    if (started) database.exec('COMMIT');
  } catch (e) { if (started) try { database.exec('ROLLBACK'); } catch {} throw e; }
  return { planItemId, revision: 1, planningStatus: 'draft' };
}

export function submitPlanItemForReview(
  database: DatabaseSync,
  input: { planItemId: string; expectedRevision: number; item: PlanItemReviewInput; by?: string; reason?: string }
): { id: string; revision: number; planningStatus: PlanningStatus } {
  if (!input.planItemId) throw Object.assign(new Error('planItemId_required'), { code: 'validation_failed' });
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw Object.assign(new Error('expectedRevision_invalid'), { code: 'validation_failed' });
  if (!input.item || typeof input.item !== 'object') throw Object.assign(new Error('item_required'), { code: 'validation_failed' });
  const validation = validatePlanItemForReview(input.item);
  if (!validation.valid) { const err: any = new Error(`validation_failed: ${validation.errors.join('; ')}`); err.code = 'validation_failed'; err.errors = validation.errors; throw err; }
  if (isExactZhihuFallback(input.item)) { const err: any = new Error('validation_failed: exact_zhihu_fallback_template'); err.code = 'validation_failed'; err.errors = ['exact_zhihu_fallback_template']; throw err; }
  const sourceIdsForValidation = getArrayField(input.item, 'sourceIds', 'source_ids', 'source_ids_json') ?? [];
  validatePlanSourceReferences(database, sourceIdsForValidation);
  validateTruthGateSourceReferences(database, readScoreReasons(input.item), sourceIdsForValidation);
  validateEditorialKnowledgeRefs(database, input.item.editorialDecision ?? input.item.editorial_decision, String(input.item.pointOfView ?? input.item.point_of_view ?? ''));
  const row = database.prepare('SELECT id, revision, planning_status, planning_provenance_json FROM plan_items WHERE id = ?').get(input.planItemId) as { id: string; revision: number; planning_status: string; planning_provenance_json: string } | undefined;
  if (!row) { const err: any = new Error('plan_item_not_found'); err.code = 'NOT_FOUND'; throw err; }
  if (row.revision !== input.expectedRevision) { const err: any = new Error(`conflict: revision mismatch expected ${input.expectedRevision} got ${row.revision}`); err.code = 'conflict'; throw err; }
  if (row.planning_status !== 'draft' && row.planning_status !== 'rejected') { const err: any = new Error(`conflict: planning_status must be draft or rejected, got ${row.planning_status}`); err.code = 'conflict'; throw err; }
  const now = nowIso();
  const by = input.by ?? 'planner';
  const reason = input.reason ?? 'submit_for_review';
  const newProvenance = appendProvenance(row.planning_provenance_json, { from: row.planning_status as PlanningStatus, to: 'ready_for_review', by: by as any, at: now, reason }, { fingerprints: { template_exact_9fields: false }, editorial_decision: input.item.editorialDecision ?? input.item.editorial_decision });
  const rawScore = readScoreReasons(input.item) as ScoreReasonsInput;
  const scoreReasonsJson = JSON.stringify(rawScore);
  const title = String((input.item as any).title ?? '').trim().slice(0, 80);
  const priority = Number.isInteger((input.item as any).priority) ? (input.item as any).priority : 0;
  const whyNow = String((input.item as any).whyNow ?? (input.item as any).why_now ?? '').trim();
  const timeliness = String((input.item as any).timeliness ?? '').trim();
  const targetAudience = String((input.item as any).targetAudience ?? (input.item as any).target_audience ?? '').trim();
  const angle = String((input.item as any).angle ?? '').trim();
  const pointOfView = String((input.item as any).pointOfView ?? (input.item as any).point_of_view ?? '').trim();
  const platforms = (input.item as any).platforms ?? [];
  const formats = (input.item as any).formats ?? [];
  const titleGuidance = String((input.item as any).titleGuidance ?? (input.item as any).title_guidance ?? '').trim();
  const openingGuidance = String((input.item as any).openingGuidance ?? (input.item as any).opening_guidance ?? '').trim();
  const structureGuidance = String((input.item as any).structureGuidance ?? (input.item as any).structure_guidance ?? '').trim();
  const effortEstimate = String((input.item as any).effortEstimate ?? (input.item as any).effort_estimate ?? '').trim();
  const sourceIds = sourceIdsForValidation;
  const availableMaterials = (input.item as any).availableMaterials ?? [];
  const missingMaterials = (input.item as any).missingMaterials ?? [];
  const reviewIds = (input.item as any).reviewIds ?? [];
  const methodFindingIds = (input.item as any).methodFindingIds ?? [];
  const topicId = (input.item as any).topicId ?? (input.item as any).topic_id ?? null;
  const result = database.prepare(
    `UPDATE plan_items
     SET title = ?, priority = ?, why_now = ?, timeliness = ?, target_audience = ?, angle = ?, point_of_view = ?, platforms_json = ?, formats_json = ?, title_guidance = ?, opening_guidance = ?, structure_guidance = ?, effort_estimate = ?, source_ids_json = ?, available_materials_json = ?, missing_materials_json = ?, review_ids_json = ?, method_finding_ids_json = ?, topic_id = ?, score_reasons_json = ?, planning_status = 'ready_for_review', revision = revision + 1, updated_at = ?, planning_provenance_json = ?
     WHERE id = ? AND revision = ? AND planning_status IN ('draft','rejected')`
  ).run(title, priority, whyNow, timeliness, targetAudience, angle, pointOfView, JSON.stringify(platforms), JSON.stringify(formats), titleGuidance, openingGuidance, structureGuidance, effortEstimate, JSON.stringify(sourceIds), JSON.stringify(availableMaterials), JSON.stringify(missingMaterials), JSON.stringify(reviewIds), JSON.stringify(methodFindingIds), topicId, scoreReasonsJson, now, newProvenance, input.planItemId, input.expectedRevision);
  if ((result as any).changes === 0) { const err: any = new Error('conflict: conditional update failed'); err.code = 'conflict'; throw err; }
  const updated = database.prepare('SELECT revision, planning_status FROM plan_items WHERE id = ?').get(input.planItemId) as { revision: number; planning_status: PlanningStatus } | undefined;
  return { id: input.planItemId, revision: updated?.revision ?? input.expectedRevision + 1, planningStatus: updated?.planning_status ?? 'ready_for_review' };
}

const ALLOWED_TRANSITIONS: Record<string, PlanningStatus[]> = {
  draft: ['draft'],
  ready_for_review: ['approved', 'rejected'],
  rejected: ['draft'],
  approved: [],
};

export function transitionPlanItem(
  database: DatabaseSync,
  input: { planItemId: string; expectedRevision: number; expectedStatus: PlanningStatus; toStatus: PlanningStatus; by: string; reason?: string }
): { id: string; revision: number; planningStatus: PlanningStatus } {
  if (!input.planItemId) throw Object.assign(new Error('planItemId_required'), { code: 'validation_failed' });
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw Object.assign(new Error('expectedRevision_invalid'), { code: 'validation_failed' });
  if (!input.expectedStatus || !input.toStatus) throw Object.assign(new Error('status_required'), { code: 'validation_failed' });
  const allowed = ALLOWED_TRANSITIONS[input.expectedStatus];
  if (!allowed || !allowed.includes(input.toStatus)) { const err: any = new Error(`conflict: illegal transition ${input.expectedStatus} -> ${input.toStatus}`); err.code = 'conflict'; throw err; }
  if (input.expectedStatus === input.toStatus && input.expectedStatus !== 'draft') { const err: any = new Error(`conflict: illegal self-transition ${input.expectedStatus}`); err.code = 'conflict'; throw err; }
  const row = database.prepare('SELECT id, revision, planning_status, planning_provenance_json, score_reasons_json, source_ids_json FROM plan_items WHERE id = ?').get(input.planItemId) as { id: string; revision: number; planning_status: PlanningStatus; planning_provenance_json: string; score_reasons_json: string; source_ids_json: string } | undefined;
  if (!row) { const err: any = new Error('plan_item_not_found'); err.code = 'NOT_FOUND'; throw err; }
  if (row.revision !== input.expectedRevision) { const err: any = new Error(`conflict: revision mismatch expected ${input.expectedRevision} got ${row.revision}`); err.code = 'conflict'; throw err; }
  if (row.planning_status !== input.expectedStatus) { const err: any = new Error(`conflict: status mismatch expected ${input.expectedStatus} got ${row.planning_status}`); err.code = 'conflict'; throw err; }
  if (input.toStatus === 'approved') {
    const sourceIds = getArrayField({ source_ids_json: row.source_ids_json }, 'source_ids_json') ?? [];
    validatePlanSourceReferences(database, sourceIds);
    validateTruthGateSourceReferences(database, row.score_reasons_json, sourceIds);
  }
  const now = nowIso();
  const newProvenance = appendProvenance(row.planning_provenance_json, { from: row.planning_status, to: input.toStatus, by: input.by as any, at: now, reason: input.reason ?? `${input.expectedStatus}->${input.toStatus}` });
  const result = database.prepare(
    `UPDATE plan_items SET planning_status = ?, revision = revision + 1, updated_at = ?, planning_provenance_json = ? WHERE id = ? AND revision = ? AND planning_status = ?`
  ).run(input.toStatus, now, newProvenance, input.planItemId, input.expectedRevision, input.expectedStatus);
  if ((result as any).changes === 0) { const err: any = new Error('conflict: conditional update failed'); err.code = 'conflict'; throw err; }
  const updated = database.prepare('SELECT revision, planning_status FROM plan_items WHERE id = ?').get(input.planItemId) as { revision: number; planning_status: PlanningStatus } | undefined;
  return { id: input.planItemId, revision: updated?.revision ?? input.expectedRevision + 1, planningStatus: updated?.planning_status ?? input.toStatus };
}
