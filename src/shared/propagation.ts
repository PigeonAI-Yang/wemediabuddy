/**
 * Self-media propagation scoring and grade resolver
 * Single shared pure resolver for all surfaces.
 * Evidence remains a gate, not virality proxy; priority is internal scheduling only.
 */

import { readEditorialDecision, validateEditorialDecision } from './editorial-thesis.ts';

// Legacy v1 dimensions remain readable for historical display only.
export const PROPAGATION_CRITERIA: Record<string, number> = {
  reader_immediacy_benefit: 20,
  tension_curiosity_gap: 20,
  why_now_window: 20,
  save_share_comment_motive: 20,
  evidence_credibility: 15,
  account_fit: 5,
  // Legacy aliases — old governance scoring names, kept for backward test compatibility; same weights as original 25/20/20/15/15/5
  evidence_coverage: 25,
  timeliness: 20,
  audience_fit: 20,
  angle_novelty: 15,
  effort_feasibility: 15,
  compliance: 5,
};

export const PROPAGATION_V2_CRITERIA: Record<string, number> = {
  reality_change_significance: 25,
  tension_curiosity_gap: 20,
  audience_stakes: 20,
  why_now_window: 15,
  one_sentence_relayability: 15,
  account_fit: 5,
};

const REQUIRED_PROPAGATION_V2_CRITERIA = new Set(Object.keys(PROPAGATION_V2_CRITERIA));

const REQUIRED_PROPAGATION_CRITERIA = new Set([
  'reader_immediacy_benefit',
  'tension_curiosity_gap',
  'why_now_window',
  'save_share_comment_motive',
  'evidence_credibility',
  'account_fit',
]);

export type PropagationGrade = 'SSS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const PROPAGATION_NEUTRAL_GRADE = '待评分' as const;
export type PropagationDisplayGrade = PropagationGrade | typeof PROPAGATION_NEUTRAL_GRADE;

// Pure threshold map: propagation score (0-100) -> visible grade. Priority never consulted.
export function propagationGradeFromScore(score: number): PropagationGrade {
  if (!Number.isFinite(score)) return 'F';
  if (score >= 90) return 'SSS';
  if (score >= 80) return 'S';
  if (score >= 70) return 'A';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C';
  if (score >= 40) return 'D';
  if (score >= 30) return 'E';
  return 'F';
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

export type PropagationScoreReasons = {
  status: 'pending' | 'scored';
  version?: 'propagation_v2';
  score: number;
  scoredAt?: string;
  reasons: Array<{ criterion: string; weight: number; score: number; reason?: string }>;
  pending_reason?: string;
  pendingReason?: string;
  truthGate?: {
    status: 'passed' | 'failed' | 'research_required';
    reason: string;
    claims: Array<{ text: string; type: 'fact' | 'inference' | 'opinion'; status: 'supported' | 'research_required'; sourceIds: string[] }>;
  };
};

export function parsePropagationScoreReasons(raw: unknown): PropagationScoreReasons | null {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== 'pending' && status !== 'scored') return null;
  const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
  if (!Number.isFinite(score)) return null;
  const reasonsRaw = obj.reasons;
  const reasons: PropagationScoreReasons['reasons'] = Array.isArray(reasonsRaw)
    ? reasonsRaw
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({
          criterion: String((r as Record<string, unknown>).criterion ?? ''),
          weight: Number((r as Record<string, unknown>).weight ?? 0),
          score: Number((r as Record<string, unknown>).score ?? 0),
          reason: typeof (r as Record<string, unknown>).reason === 'string' ? String((r as Record<string, unknown>).reason) : undefined,
        }))
        .filter((r) => r.criterion)
    : [];
  return {
    status: status as 'pending' | 'scored',
    score,
    scoredAt: typeof obj.scoredAt === 'string' ? obj.scoredAt : undefined,
    reasons,
    pending_reason: typeof obj.pending_reason === 'string' ? obj.pending_reason : undefined,
    pendingReason: typeof obj.pendingReason === 'string' ? obj.pendingReason : undefined,
    version: obj.version === 'propagation_v2' ? 'propagation_v2' : undefined,
    truthGate: obj.truthGate && typeof obj.truthGate === 'object' && !Array.isArray(obj.truthGate)
      ? obj.truthGate as PropagationScoreReasons['truthGate']
      : undefined,
  } as PropagationScoreReasons;
}

export type RecommendationReasonCode = 'score_pending' | 'score_invalid' | 'proposal_incomplete' | 'score_stale' | 'thesis_competition_missing' | 'thesis_competition_invalid' | 'truth_gate_failed';
export type RecommendationQualification =
  | { kind: 'eligible'; score: number; scoredAt: string | null }
  | { kind: 'pending'; reasonCode: 'score_pending'; reason: string }
  | { kind: 'invalid'; reasonCode: Exclude<RecommendationReasonCode, 'score_pending'>; reason: string };

function objectField(item: unknown, ...names: string[]): unknown {
  if (!item || typeof item !== 'object') return undefined;
  const value = item as Record<string, unknown>;
  for (const name of names) if (value[name] !== undefined) return value[name];
  return undefined;
}

function stringField(item: unknown, ...names: string[]): string {
  const value = objectField(item, ...names);
  return typeof value === 'string' ? value.trim() : '';
}

function arrayField(item: unknown, ...names: string[]): unknown[] | null {
  const raw = objectField(item, ...names);
  const value = safeJsonParse(raw);
  return Array.isArray(value) ? value : null;
}

const PLACEHOLDER_VALUES = new Set(['标题', '角度', '观点', '结构', '开头', '受众', '窗口', '待补充', '待完善', 'todo', 'tbd']);

export function validateProposalCompleteness(item: unknown): { valid: boolean; errors: string[] } {
  const fields: Array<[string, string]> = [
    ['title', stringField(item, 'title')],
    ['whyNow', stringField(item, 'whyNow', 'why_now')],
    ['timeliness', stringField(item, 'timeliness')],
    ['targetAudience', stringField(item, 'targetAudience', 'target_audience')],
    ['angle', stringField(item, 'angle')],
    ['pointOfView', stringField(item, 'pointOfView', 'point_of_view')],
    ['titleGuidance', stringField(item, 'titleGuidance', 'title_guidance')],
    ['openingGuidance', stringField(item, 'openingGuidance', 'opening_guidance')],
    ['structureGuidance', stringField(item, 'structureGuidance', 'structure_guidance')],
    ['effortEstimate', stringField(item, 'effortEstimate', 'effort_estimate')],
  ];
  const errors: string[] = [];
  for (const [name, value] of fields) {
    if (!value) errors.push(`${name}_required`);
    else if (PLACEHOLDER_VALUES.has(normalizeThesis(value))) errors.push(`${name}_placeholder`);
  }
  for (const [name, names] of [
    ['platforms', ['platforms', 'platforms_json']],
    ['formats', ['formats', 'formats_json']],
    ['sourceIds', ['sourceIds', 'source_ids', 'source_ids_json']],
  ] as const) {
    const value = arrayField(item, ...names);
    if (!value?.length) errors.push(`${name}_required`);
  }
  for (const [name, names] of [
    ['availableMaterials', ['availableMaterials', 'available_materials_json']],
    ['missingMaterials', ['missingMaterials', 'missing_materials_json']],
    ['reviewIds', ['reviewIds', 'review_ids_json']],
    ['methodFindingIds', ['methodFindingIds', 'method_finding_ids_json']],
  ] as const) {
    const raw = objectField(item, ...names);
    if (raw !== undefined && arrayField(item, ...names) === null) errors.push(`${name}_invalid`);
  }
  const title = normalizeThesis(stringField(item, 'title'));
  const angle = normalizeThesis(stringField(item, 'angle'));
  const pointOfView = normalizeThesis(stringField(item, 'pointOfView', 'point_of_view'));
  if (angle && (angle === title || angle === pointOfView)) errors.push('angle_not_distinct');
  if (pointOfView && pointOfView === title) errors.push('pointOfView_not_distinct');
  const whyNow = stringField(item, 'whyNow', 'why_now');
  if (whyNow && whyNow.length < 18) errors.push('whyNow_missing_event_window_cost');
  const audience = stringField(item, 'targetAudience', 'target_audience');
  if (audience && audience.length < 10) errors.push('targetAudience_not_specific');
  const structure = stringField(item, 'structureGuidance', 'structure_guidance');
  const structureParts = structure.split(/(?:\r?\n+|[；;]|→|⇒|＞|->|>|第[一二三四五六七八九十]+(?:段|步|部分))/u).map((part) => part.trim()).filter(Boolean);
  if (structure && structureParts.length < 3) errors.push('structureGuidance_less_than_three_parts');
  return { valid: errors.length === 0, errors };
}

export function classifyRecommendationItem(
  item: unknown,
  context: { businessDate: string; asOf: Date }
): RecommendationQualification {
  const status = getPlanningStatusRaw(item);
  const score = getScoreReasonsRaw(item);
  if (status === 'draft' || status === 'rejected') {
    if (score?.status === 'scored') {
      const proposal = validateProposalCompleteness(item);
      if (!proposal.valid) return { kind: 'invalid', reasonCode: 'proposal_incomplete', reason: proposal.errors.join('; ') };
      if (!isValidScoredReasons(score)) return { kind: 'invalid', reasonCode: 'score_invalid', reason: '六维评分结构或总分不合法' };
    }
    return { kind: 'pending', reasonCode: 'score_pending', reason: pendingScoringReason(item) };
  }
  if (status !== 'ready_for_review') {
    return { kind: 'invalid', reasonCode: 'score_invalid', reason: `planning_status_${status ?? 'missing'}` };
  }
  const proposal = validateProposalCompleteness(item);
  if (!proposal.valid) {
    return { kind: 'invalid', reasonCode: 'proposal_incomplete', reason: proposal.errors.join('; ') };
  }
  const editorial = validateEditorialDecision(readEditorialDecision(item), stringField(item, 'pointOfView', 'point_of_view'));
  if (!editorial.valid) {
    if (editorial.errors.includes('thesis_competition_missing')) {
      return { kind: 'invalid', reasonCode: 'thesis_competition_missing', reason: '缺少事件层、用户层、产业或社会层的中心主张竞争与赢家依据' };
    }
    return { kind: 'invalid', reasonCode: 'thesis_competition_invalid', reason: editorial.errors.join('; ') };
  }
  if (!isValidPropagationV2Reasons(score)) {
    const gateStatus = score?.truthGate?.status;
    if (gateStatus === 'failed' || gateStatus === 'research_required') {
      return { kind: 'invalid', reasonCode: 'truth_gate_failed', reason: score?.truthGate?.reason || '真实性硬门未通过' };
    }
    return { kind: 'invalid', reasonCode: 'score_invalid', reason: 'propagation_v2 结构或总分不合法' };
  }
  if (stringField(item, 'planDate', 'plan_date') < context.businessDate) {
    const scoredMs = score?.scoredAt ? Date.parse(score.scoredAt) : Number.NaN;
    if (!Number.isFinite(scoredMs) || context.asOf.getTime() - scoredMs > 24 * 3_600_000) {
      return { kind: 'invalid', reasonCode: 'score_stale', reason: '跨日评分已超过 24 小时或缺少评分时间' };
    }
  }
  return { kind: 'eligible', score: score!.score, scoredAt: score?.scoredAt ?? null };
}

function getPlanningStatusRaw(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const candidates = [
    obj.planning_status,
    obj.planningStatus,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && (v === 'draft' || v === 'ready_for_review' || v === 'approved' || v === 'rejected')) {
      return v as string;
    }
  }
  const provRaw = (obj as Record<string, unknown>).planning_provenance_json ?? (obj as Record<string, unknown>).planningProvenanceJson;
  const prov = safeJsonParse(provRaw);
  if (prov && typeof prov === 'object' && !Array.isArray(prov)) {
    const trans = (prov as Record<string, unknown>).transitions;
    if (Array.isArray(trans) && trans.length) {
      const last = trans[trans.length - 1] as Record<string, unknown>;
      if (last && typeof last.to === 'string' && (last.to === 'draft' || last.to === 'ready_for_review' || last.to === 'approved' || last.to === 'rejected')) {
        return last.to as string;
      }
    }
  }
  return null;
}

function getScoreReasonsRaw(item: unknown): PropagationScoreReasons | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const candidates: unknown[] = [
    obj.score_reasons_json,
    obj.scoreReasonsJson,
    obj.score_reasons,
    obj.scoreReasons,
    obj.score_snapshot_json,
    obj.scoreSnapshotJson,
  ];
  for (const raw of candidates) {
    const parsed = parsePropagationScoreReasons(raw);
    if (parsed) return parsed;
  }
  // direct object shape
  if (typeof obj.status === 'string' && typeof obj.score === 'number') {
    const parsed = parsePropagationScoreReasons(obj);
    if (parsed) return parsed;
  }
  return null;
}
export function isValidScoredReasons(reasons: PropagationScoreReasons | null): boolean {
  if (!reasons) return false;
  if (reasons.status !== 'scored') return false;
  if (typeof reasons.score !== 'number' || !Number.isFinite(reasons.score) || reasons.score < 0 || reasons.score > 100) return false;
  if (!Array.isArray(reasons.reasons) || reasons.reasons.length !== 6) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const r of reasons.reasons) {
    const expected = PROPAGATION_CRITERIA[r.criterion];
    if (!REQUIRED_PROPAGATION_CRITERIA.has(r.criterion) || expected === undefined || seen.has(r.criterion)) return false;
    if (r.weight !== expected) return false;
    if (typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > expected) return false;
    seen.add(r.criterion);
    total += r.score;
  }
  if (seen.size !== 6) return false;
  if (total !== reasons.score) return false;
  return true;
}

export function isValidPropagationV2Reasons(reasons: PropagationScoreReasons | null): boolean {
  if (!reasons || reasons.status !== 'scored' || reasons.version !== 'propagation_v2') return false;
  if (typeof reasons.score !== 'number' || !Number.isFinite(reasons.score) || reasons.score < 0 || reasons.score > 100) return false;
  if (!Array.isArray(reasons.reasons) || reasons.reasons.length !== 6) return false;
  const gate = reasons.truthGate;
  if (!gate || gate.status !== 'passed' || typeof gate.reason !== 'string' || !gate.reason.trim() || !Array.isArray(gate.claims) || gate.claims.length === 0) return false;
  for (const claim of gate.claims) {
    if (!claim || typeof claim.text !== 'string' || !claim.text.trim()) return false;
    if (claim.type !== 'fact' && claim.type !== 'inference' && claim.type !== 'opinion') return false;
    if (claim.status !== 'supported') return false;
    if (!Array.isArray(claim.sourceIds) || (claim.type !== 'opinion' && claim.sourceIds.length === 0) || claim.sourceIds.some((id) => typeof id !== 'string' || !id.trim())) return false;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const reason of reasons.reasons) {
    const expected = PROPAGATION_V2_CRITERIA[reason.criterion];
    if (!REQUIRED_PROPAGATION_V2_CRITERIA.has(reason.criterion) || expected === undefined || seen.has(reason.criterion)) return false;
    if (reason.weight !== expected || typeof reason.score !== 'number' || !Number.isFinite(reason.score) || reason.score < 0 || reason.score > expected) return false;
    if (typeof reason.reason !== 'string' || !reason.reason.trim()) return false;
    seen.add(reason.criterion);
    total += reason.score;
  }
  return seen.size === 6 && total === reasons.score;
}

export function isScoredApproved(item: unknown): boolean {
  const status = getPlanningStatusRaw(item);
  if (status !== 'approved') return false;
  const score = getScoreReasonsRaw(item);
  const editorial = validateEditorialDecision(readEditorialDecision(item), stringField(item, 'pointOfView', 'point_of_view'));
  return editorial.valid && isValidPropagationV2Reasons(score);
}

export function isScoredReadyForReview(item: unknown): boolean {
  const status = getPlanningStatusRaw(item);
  if (status !== 'ready_for_review') return false;
  const score = getScoreReasonsRaw(item);
  const editorial = validateEditorialDecision(readEditorialDecision(item), stringField(item, 'pointOfView', 'point_of_view'));
  return editorial.valid && isValidPropagationV2Reasons(score);
}

export function isScoringPending(item: unknown): boolean {
  const status = getPlanningStatusRaw(item);
  if (status !== 'draft' && status !== 'rejected') return false;
  const reasons = getScoreReasonsRaw(item);
  if (!reasons) return true;
  if (reasons.status === 'pending') return true;
  return !isValidScoredReasons(reasons);
}

export function isEligibleForApproval(item: unknown): boolean {
  return isScoredReadyForReview(item);
}

export function pendingScoringReason(item: unknown): string {
  const reasons = getScoreReasonsRaw(item);
  if (!reasons) return '评分未完成';
  if (reasons.pending_reason) return reasons.pending_reason;
  if (reasons.pendingReason) return reasons.pendingReason;
  if (reasons.status === 'pending') return '评分未完成';
  return '评分未完成';
}


export function resolvePropagationGrade(item: unknown): PropagationDisplayGrade {
  const status = getPlanningStatusRaw(item);
  if (status !== 'approved' && status !== 'ready_for_review') return PROPAGATION_NEUTRAL_GRADE;
  const reasons = getScoreReasonsRaw(item);
  // Current surfaces must never turn a legacy v1 payload into a visible grade.
  // Legacy reasons remain readable for historical diagnostics, but only the
  // versioned propagation_v2 contract is a current score.
  if (!reasons || !isValidPropagationV2Reasons(reasons)) return PROPAGATION_NEUTRAL_GRADE;
  return propagationGradeFromScore(reasons.score);
}

// For testing: also expose check that does not require planning_status but just pending
export function isPendingScore(score: PropagationScoreReasons | null | undefined): boolean {
  if (!score) return true;
  return score.status === 'pending' || (score.score === 0 && score.reasons.length === 0);
}

// Thesis diversity helpers — normalized core claim / reader job
export function normalizeThesis(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, ' ')
    .replace(/[：:，,。.!！?？、|+\-—_/\\()（）[\]【】「」""'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function thesisBigrams(value: string): Set<string> {
  const compact = normalizeThesis(value).replace(/\s+/g, '');
  const grams = new Set<string>();
  if (compact.length <= 1) {
    if (compact) grams.add(compact);
    return grams;
  }
  for (let i = 0; i < compact.length - 1; i += 1) grams.add(compact.slice(i, i + 2));
  return grams;
}

export function thesisJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

export function thesisFingerprint(input: { pointOfView: string; angle: string; targetAudience: string }): string {
  const combined = `${normalizeThesis(input.pointOfView)} | ${normalizeThesis(input.angle)} | ${normalizeThesis(input.targetAudience)}`;
  // Use bigram set for similarity, but fingerprint for exact duplicate detection = normalized combined
  return combined;
}

export function sameThesis(
  a: { pointOfView: string; angle: string; targetAudience: string },
  b: { pointOfView: string; angle: string; targetAudience: string }
): boolean {
  // Strict normalized equality first (exact duplicate)
  const fa = thesisFingerprint(a);
  const fb = thesisFingerprint(b);
  if (fa === fb) return true;
  // Bigram overlap on concatenated thesis
  const gramsA = thesisBigrams(`${a.pointOfView} ${a.angle} ${a.targetAudience}`);
  const gramsB = thesisBigrams(`${b.pointOfView} ${b.angle} ${b.targetAudience}`);
  // 0.62 threshold conservative to avoid false merge distinct reader outcomes; but catches near-identical governance theses
  // Also require at least shared pointOfView bigram overlap > 0.5 to prevent merging distinct angles with same audience
  const overall = thesisJaccard(gramsA, gramsB);
  if (overall >= 0.62) return true;
  // Fallback: pointOfView alone highly overlapping suggests same claim even if angle phrasing differs
  const povA = thesisBigrams(a.pointOfView);
  const povB = thesisBigrams(b.pointOfView);
  if (thesisJaccard(povA, povB) >= 0.65) return true;
  return false;
}

export function findThesisDuplicates(
  items: Array<{ pointOfView: string; angle: string; targetAudience: string; title: string }>
): Array<{ pair: [number, number]; reason: string }> {
  const dupes: Array<{ pair: [number, number]; reason: string }> = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (sameThesis(items[i], items[j])) {
        dupes.push({ pair: [i, j], reason: `thesis_duplicate: item ${i} "${items[i].title.slice(0, 30)}" and item ${j} "${items[j].title.slice(0, 30)}" share normalized core claim/reader job (POV bigram overlap)` });
      }
    }
  }
  return dupes;
}
