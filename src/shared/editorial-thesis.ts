export const EDITORIAL_THESIS_LEVELS = ['event', 'user', 'industry_or_society'] as const;
export type EditorialThesisLevel = typeof EDITORIAL_THESIS_LEVELS[number];
export type EditorialClaimType = 'fact' | 'inference' | 'opinion';
export type EditorialEvidenceStatus = 'supported' | 'research_required';

export type EditorialThesisCandidate = {
  level: EditorialThesisLevel;
  thesis: string;
  claimType: EditorialClaimType;
  evidenceStatus: EditorialEvidenceStatus;
  evidenceBoundary: string;
  score: number;
  reason: string;
};

export type EditorialKnowledgeContext = {
  status: 'used' | 'no_relevant_context';
  contextRefs: string[];
  queryDimensions: string[];
  reason: string;
};

export type EditorialDecision = {
  version: 'editorial_thesis_v1';
  candidates: EditorialThesisCandidate[];
  winnerLevel: EditorialThesisLevel;
  winnerThesis: string;
  winnerReason: string;
  knowledgeContext: EditorialKnowledgeContext;
};

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

export function readEditorialDecision(item: unknown): unknown {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const direct = row.editorialDecision ?? row.editorial_decision;
  if (direct !== undefined) return parseJson(direct);
  const provenance = parseJson(row.planning_provenance_json ?? row.planningProvenanceJson);
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return null;
  return parseJson((provenance as Record<string, unknown>).editorial_decision);
}

export function validateEditorialDecision(
  raw: unknown,
  expectedWinnerThesis?: string,
): { valid: boolean; errors: string[]; value: EditorialDecision | null } {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['thesis_competition_missing'], value: null };
  }
  const value = parsed as Record<string, unknown>;
  const errors: string[] = [];
  if (value.version !== 'editorial_thesis_v1') errors.push('thesis_competition_version_invalid');
  const candidatesRaw = Array.isArray(value.candidates) ? value.candidates : [];
  if (candidatesRaw.length < 3) errors.push('thesis_candidates_three_levels_required');
  const candidates: EditorialThesisCandidate[] = [];
  const seenLevels = new Set<string>();
  const seenTheses = new Set<string>();
  for (const candidateRaw of candidatesRaw) {
    if (!candidateRaw || typeof candidateRaw !== 'object' || Array.isArray(candidateRaw)) {
      errors.push('thesis_candidate_invalid');
      continue;
    }
    const candidate = candidateRaw as Record<string, unknown>;
    const level = candidate.level;
    const thesis = typeof candidate.thesis === 'string' ? candidate.thesis.trim() : '';
    const claimType = candidate.claimType;
    const evidenceStatus = candidate.evidenceStatus;
    const evidenceBoundary = typeof candidate.evidenceBoundary === 'string' ? candidate.evidenceBoundary.trim() : '';
    const score = candidate.score;
    const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
    if (!EDITORIAL_THESIS_LEVELS.includes(level as EditorialThesisLevel)) errors.push('thesis_candidate_level_invalid');
    else if (seenLevels.has(String(level))) errors.push('thesis_candidate_level_duplicate');
    else seenLevels.add(String(level));
    if (!thesis) errors.push('thesis_candidate_text_required');
    const normalized = normalize(thesis);
    if (normalized && seenTheses.has(normalized)) errors.push('thesis_candidates_not_semantically_distinct');
    if (normalized) seenTheses.add(normalized);
    if (claimType !== 'fact' && claimType !== 'inference' && claimType !== 'opinion') errors.push('thesis_claim_type_invalid');
    if (evidenceStatus !== 'supported' && evidenceStatus !== 'research_required') errors.push('thesis_evidence_status_invalid');
    if (!evidenceBoundary) errors.push('thesis_evidence_boundary_required');
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) errors.push('thesis_candidate_score_invalid');
    if (!reason) errors.push('thesis_candidate_reason_required');
    if (
      EDITORIAL_THESIS_LEVELS.includes(level as EditorialThesisLevel) && thesis &&
      (claimType === 'fact' || claimType === 'inference' || claimType === 'opinion') &&
      (evidenceStatus === 'supported' || evidenceStatus === 'research_required') &&
      evidenceBoundary && typeof score === 'number' && Number.isFinite(score) && reason
    ) {
      candidates.push({
        level: level as EditorialThesisLevel, thesis, claimType, evidenceStatus,
        evidenceBoundary, score, reason,
      });
    }
  }
  for (const level of EDITORIAL_THESIS_LEVELS) if (!seenLevels.has(level)) errors.push(`thesis_level_${level}_required`);

  const winnerLevel = value.winnerLevel;
  const winnerThesis = typeof value.winnerThesis === 'string' ? value.winnerThesis.trim() : '';
  const winnerReason = typeof value.winnerReason === 'string' ? value.winnerReason.trim() : '';
  const winner = candidates.find((candidate) => candidate.level === winnerLevel && normalize(candidate.thesis) === normalize(winnerThesis));
  if (!winner) errors.push('thesis_winner_not_in_candidates');
  if (!winnerReason) errors.push('thesis_winner_reason_required');
  if (winner && winner.score !== Math.max(...candidates.map((candidate) => candidate.score))) errors.push('thesis_winner_not_highest_propagation_value');
  if (winner?.evidenceStatus === 'research_required') errors.push('thesis_winner_research_required');
  if (expectedWinnerThesis && winner && normalize(winner.thesis) !== normalize(expectedWinnerThesis)) errors.push('thesis_winner_does_not_match_point_of_view');

  const knowledgeRaw = value.knowledgeContext;
  let knowledgeContext: EditorialKnowledgeContext | null = null;
  if (!knowledgeRaw || typeof knowledgeRaw !== 'object' || Array.isArray(knowledgeRaw)) {
    errors.push('knowledge_context_receipt_required');
  } else {
    const knowledge = knowledgeRaw as Record<string, unknown>;
    const status = knowledge.status;
    const contextRefs = knowledge.contextRefs;
    const queryDimensions = knowledge.queryDimensions;
    const reason = typeof knowledge.reason === 'string' ? knowledge.reason.trim() : '';
    if (status !== 'used' && status !== 'no_relevant_context') errors.push('knowledge_context_status_invalid');
    if (!Array.isArray(contextRefs) || contextRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) errors.push('knowledge_context_refs_invalid');
    if (status === 'used' && (!Array.isArray(contextRefs) || contextRefs.length === 0)) errors.push('knowledge_context_used_refs_required');
    if (status === 'no_relevant_context' && Array.isArray(contextRefs) && contextRefs.length > 0) errors.push('knowledge_context_no_relevant_refs_must_be_empty');
    if (!nonEmptyStrings(queryDimensions) || queryDimensions.length < 2) errors.push('knowledge_context_query_dimensions_required');
    if (!reason) errors.push('knowledge_context_reason_required');
    if ((status === 'used' || status === 'no_relevant_context') && Array.isArray(contextRefs) && nonEmptyStrings(queryDimensions) && reason) {
      knowledgeContext = { status, contextRefs: contextRefs as string[], queryDimensions, reason };
    }
  }

  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length || !winner || !knowledgeContext) return { valid: false, errors: uniqueErrors, value: null };
  return {
    valid: true,
    errors: [],
    value: {
      version: 'editorial_thesis_v1', candidates,
      winnerLevel: winnerLevel as EditorialThesisLevel,
      winnerThesis, winnerReason, knowledgeContext,
    },
  };
}
