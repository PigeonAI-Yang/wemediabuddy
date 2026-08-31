/**
 * WMB-5332/WMB-5350 Planner scoring — six dimensions, hard-risk reject-before-score, 30-day duplicate, routing, quota.
 * Deterministic, no model calls. Persists snapshots through daily_content_targets.score_snapshot_json
 * and exposes per-dimension evidence via Proposal Ledger (existing components/tokens).
 * WMB-5350: scores driven by real source summary/excerpt/heat/categories/material facts; missing body => pending/0 not 100.
 */
import type { DatabaseSync } from 'node:sqlite';
import { canonicalizeZhihuQuestionUrl } from './zhihu-hot-channel.ts';

export const ZHIHU_SCORING_DIMENSION_CAPS = Object.freeze({
  audienceFit: 25,
  viewpointRoom: 20,
  evidenceAvailability: 20,
  timelinessLifecycle: 15,
  articleVideoTransfer: 15,
  executionCost: 5,
} as const);

export const ZHIHU_HARD_RISK_CODES = Object.freeze([
  'fact_unverifiable',
  'illegal_infringement',
  'private_data_required',
  'duplicate_no_value',
] as const);
export type ZhihuHardRiskCode = (typeof ZHIHU_HARD_RISK_CODES)[number];

export const ZHIHU_SCORING_DEFAULTS = Object.freeze({
  autoThreshold: 75,
  boundaryThreshold: 55,
  targetCount: 2,
} as const);

export type ZhihuScoringSettings = Readonly<{
  autoThreshold: number;
  boundaryThreshold: number;
  targetCount: number;
}>;

export type ZhihuDimensionEvidence = Readonly<{
  evidence?: string;
  reason?: string;
}>;

export type ZhihuScoringInput = Readonly<{
  id: string;
  canonicalUrl?: string | null;
  title: string;
  audienceFit: number;
  viewpointRoom: number;
  evidenceAvailability: number;
  timelinessLifecycle: number;
  articleVideoTransfer: number;
  executionCost: number;
  hardRisks?: readonly string[];
  dimensionEvidence?: Readonly<Record<string, ZhihuDimensionEvidence>>;
  hasNewEvidence?: boolean;
  hasNewAudience?: boolean;
  hasNewViewpoint?: boolean;
  rank?: number;
}>;

export type ZhihuScoredCandidate = Readonly<{
  id: string;
  canonicalUrl: string | null;
  title: string;
  rank: number | null;
  total: number;
  dims: {
    audienceFit: number;
    viewpointRoom: number;
    evidenceAvailability: number;
    timelinessLifecycle: number;
    articleVideoTransfer: number;
    executionCost: number;
  };
  risks: readonly string[];
  hardRiskCodes: readonly ZhihuHardRiskCode[];
  duplicate: boolean;
  duplicateReason?: string;
  route: 'automatic' | 'boundary' | 'rejected';
  proposalReason: string;
  dimensionEvidence: Record<string, ZhihuDimensionEvidence>;
  rawInput: ZhihuScoringInput;
}>;

export type ZhihuQuotaSelection = Readonly<{
  automatic: ZhihuScoredCandidate[];
  boundary: ZhihuScoredCandidate[];
  rejected: ZhihuScoredCandidate[];
  selected: ZhihuScoredCandidate[];
  visibleBoundary: ZhihuScoredCandidate[];
}>;

const APP_META_KEYS = {
  auto: 'zhihu_scoring_auto_threshold',
  boundary: 'zhihu_scoring_boundary_threshold',
  target: 'zhihu_scoring_target_count',
} as const;

function clampDim(value: number, cap: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(cap, Math.floor(value)));
}

function stableHardRisks(inputRisks: readonly string[] | undefined): ZhihuHardRiskCode[] {
  if (!inputRisks?.length) return [];
  const allowed = new Set<string>(ZHIHU_HARD_RISK_CODES);
  const out: ZhihuHardRiskCode[] = [];
  for (const r of inputRisks) {
    if (allowed.has(r) && !out.includes(r as ZhihuHardRiskCode)) out.push(r as ZhihuHardRiskCode);
  }
  out.sort();
  return out;
}

export function getScoringSettings(database: DatabaseSync): ZhihuScoringSettings {
  try {
    const rows = database
      .prepare('SELECT key, value FROM app_meta WHERE key IN (?,?,?)')
      .all(APP_META_KEYS.auto, APP_META_KEYS.boundary, APP_META_KEYS.target) as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const auto = map.has(APP_META_KEYS.auto) ? Number(map.get(APP_META_KEYS.auto)) : ZHIHU_SCORING_DEFAULTS.autoThreshold;
    const boundary = map.has(APP_META_KEYS.boundary) ? Number(map.get(APP_META_KEYS.boundary)) : ZHIHU_SCORING_DEFAULTS.boundaryThreshold;
    const target = map.has(APP_META_KEYS.target) ? Number(map.get(APP_META_KEYS.target)) : ZHIHU_SCORING_DEFAULTS.targetCount;
    const validated = validateScoringSettings({ autoThreshold: auto, boundaryThreshold: boundary, targetCount: target });
    return validated;
  } catch {
    return { ...ZHIHU_SCORING_DEFAULTS };
  }
}

function validateScoringSettings(input: {
  autoThreshold: number;
  boundaryThreshold: number;
  targetCount: number;
}): ZhihuScoringSettings {
  const auto = Number.isFinite(input.autoThreshold) ? Math.floor(input.autoThreshold) : ZHIHU_SCORING_DEFAULTS.autoThreshold;
  const boundary = Number.isFinite(input.boundaryThreshold) ? Math.floor(input.boundaryThreshold) : ZHIHU_SCORING_DEFAULTS.boundaryThreshold;
  const target = Number.isFinite(input.targetCount) ? Math.floor(input.targetCount) : ZHIHU_SCORING_DEFAULTS.targetCount;
  if (auto < 0 || auto > 100) throw Object.assign(new Error('autoThreshold must be 0..100'), { code: 'VALIDATION_ERROR' });
  if (boundary < 0 || boundary > 100) throw Object.assign(new Error('boundaryThreshold must be 0..100'), { code: 'VALIDATION_ERROR' });
  if (target < 1 || target > 5) throw Object.assign(new Error('targetCount must be 1..5'), { code: 'VALIDATION_ERROR' });
  if (!(auto > boundary)) throw Object.assign(new Error('autoThreshold must be > boundaryThreshold'), { code: 'VALIDATION_ERROR' });
  return { autoThreshold: auto, boundaryThreshold: boundary, targetCount: target };
}

export function setScoringSettings(database: DatabaseSync, input: Partial<ZhihuScoringSettings>): ZhihuScoringSettings {
  const current = getScoringSettings(database);
  const next = validateScoringSettings({
    autoThreshold: input.autoThreshold ?? current.autoThreshold,
    boundaryThreshold: input.boundaryThreshold ?? current.boundaryThreshold,
    targetCount: input.targetCount ?? current.targetCount,
  });
  const now = new Date().toISOString();
  const upsert = (key: string, value: string): void => {
    const exists = database.prepare('SELECT revision FROM app_meta WHERE key=?').get(key) as { revision: number } | undefined;
    if (exists) database.prepare('UPDATE app_meta SET value=?, updated_at=?, revision=revision+1 WHERE key=?').run(value, now, key);
    else database.prepare('INSERT INTO app_meta (key,value,created_at,updated_at,revision) VALUES (?,?,?,?,1)').run(key, value, now, now);
  };
  upsert(APP_META_KEYS.auto, String(next.autoThreshold));
  upsert(APP_META_KEYS.boundary, String(next.boundaryThreshold));
  upsert(APP_META_KEYS.target, String(next.targetCount));
  return next;
}

export function isDuplicateWithin30Days(
  database: DatabaseSync,
  canonicalUrl: string | null,
  title: string,
  nowIso: string,
  excludeSourceId?: string | null
): { duplicate: boolean; reason?: string } {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return { duplicate: false };
  const cutoffIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (canonicalUrl) {
    const normalized = canonicalizeZhihuQuestionUrl(canonicalUrl) ?? canonicalUrl;
    const hit = excludeSourceId
      ? (database
          .prepare('SELECT id FROM source_items WHERE canonical_url=? AND collected_at >= ? AND id != ? LIMIT 1')
          .get(normalized, cutoffIso, excludeSourceId) as { id: string } | undefined)
      : (database
          .prepare('SELECT id FROM source_items WHERE canonical_url=? AND collected_at >= ? LIMIT 1')
          .get(normalized, cutoffIso) as { id: string } | undefined);
    if (hit) return { duplicate: true, reason: `canonical ${normalized} within 30d` };
    const targetHit = database
      .prepare('SELECT id FROM daily_content_targets WHERE source_item_id IN (SELECT id FROM source_items WHERE canonical_url=?) AND created_at >= ? LIMIT 1')
      .get(normalized, cutoffIso) as { id: string } | undefined;
    if (targetHit) return { duplicate: true, reason: `target for ${normalized} within 30d` };
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    const tHit = excludeSourceId
      ? (database.prepare('SELECT id FROM source_items WHERE title=? AND collected_at >= ? AND id != ? LIMIT 1').get(trimmedTitle, cutoffIso, excludeSourceId) as { id: string } | undefined)
      : (database.prepare('SELECT id FROM source_items WHERE title=? AND collected_at >= ? LIMIT 1').get(trimmedTitle, cutoffIso) as { id: string } | undefined);
    if (tHit) return { duplicate: true, reason: `title "${trimmedTitle}" within 30d` };
  }
  return { duplicate: false };
}

function proposalReasonFor(
  input: { total: number; hardRisks: ZhihuHardRiskCode[]; duplicate: boolean; hasNewValue: boolean },
  settings: ZhihuScoringSettings
): string {
  if (input.hardRisks.length) return `hard-risk: ${input.hardRisks.join(',')}`;
  if (input.duplicate && !input.hasNewValue) return 'duplicate_no_value: 30d within window without new evidence/audience/viewpoint';
  if (input.total >= settings.autoThreshold) return `auto: total ${input.total} >= ${settings.autoThreshold} and no hard risk`;
  if (input.total >= settings.boundaryThreshold)
    return `boundary: total ${input.total} in [${settings.boundaryThreshold},${settings.autoThreshold}) or needs owner judgment`;
  return `rejected: total ${input.total} < ${settings.boundaryThreshold}`;
}

type EvidenceFacts = {
  hasSummary: boolean;
  summaryLen: number;
  summaryText: string;
  hasExcerpt: boolean;
  excerptLen: number;
  excerptText: string;
  hasHeat: boolean;
  heatText: string | null;
  heatValue: number | null;
  categories: string[];
  hasCategories: boolean;
  canonicalUrl: string | null;
  collectedAt: string | null;
};

function parseHeatValue(text: string | null): number | null {
  if (!text) return null;
  const wanMatch = text.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wanMatch) {
    const v = Number.parseFloat(wanMatch[1]);
    if (Number.isFinite(v)) return Math.floor(v * 10000);
  }
  const digits = text.replace(/[^\d]/g, '');
  if (digits) {
    const n = Number.parseInt(digits, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function fetchEvidenceFacts(database: DatabaseSync, sourceId: string): EvidenceFacts {
  let summaryText = '';
  let categories: string[] = [];
  let canonicalUrl: string | null = null;
  try {
    const row = database
      .prepare('SELECT summary, categories_json, canonical_url FROM source_items WHERE id = ?')
      .get(sourceId) as { summary: string | null; categories_json: string | null; canonical_url: string | null } | undefined;
    if (row) {
      summaryText = typeof row.summary === 'string' ? row.summary : '';
      canonicalUrl = row.canonical_url ?? null;
      try {
        const parsed = row.categories_json ? (JSON.parse(row.categories_json) as unknown) : [];
        if (Array.isArray(parsed)) categories = parsed.filter((v): v is string => typeof v === 'string');
      } catch {
        categories = [];
      }
    }
  } catch {}
  let heatText: string | null = null;
  let excerptText = '';
  let collectedAt: string | null = null;
  try {
    const obs = database
      .prepare('SELECT heat_text, excerpt_snapshot, collected_at FROM zhihu_hot_observations WHERE source_item_id = ? ORDER BY collected_at DESC LIMIT 1')
      .get(sourceId) as { heat_text: string | null; excerpt_snapshot: string | null; collected_at: string | null } | undefined;
    if (obs) {
      heatText = obs.heat_text ?? null;
      excerptText = typeof obs.excerpt_snapshot === 'string' ? obs.excerpt_snapshot : '';
      collectedAt = obs.collected_at ?? null;
    }
  } catch {}
  const hasSummary = summaryText.trim().length > 10;
  const hasExcerpt = excerptText.trim().length > 10;
  const hasHeat = typeof heatText === 'string' && heatText.trim().length > 0;
  return {
    hasSummary,
    summaryLen: summaryText.trim().length,
    summaryText,
    hasExcerpt,
    excerptLen: excerptText.trim().length,
    excerptText,
    hasHeat,
    heatText,
    heatValue: parseHeatValue(heatText),
    categories,
    hasCategories: categories.length > 0,
    canonicalUrl,
    collectedAt,
  };
}

function computeEvidenceDrivenDims(ev: EvidenceFacts, rank: number | null, duplicate: boolean, nowIso: string): {
  audienceFit: number;
  viewpointRoom: number;
  evidenceAvailability: number;
  timelinessLifecycle: number;
  articleVideoTransfer: number;
  executionCost: number;
} {
  const isInsufficient = !ev.hasSummary && !ev.hasExcerpt;
  if (isInsufficient) {
    return {
      audienceFit: 0,
      viewpointRoom: 0,
      evidenceAvailability: 0,
      timelinessLifecycle: 0,
      articleVideoTransfer: 0,
      executionCost: 0,
    };
  }

  let audienceFit = 0;
  if (ev.hasCategories) audienceFit += 8 + Math.min(7, ev.categories.length * 2);
  if (ev.hasSummary) audienceFit += 5;
  if (ev.summaryText && /AI|智能|模型|技术|行业|大模型/.test(ev.summaryText)) audienceFit += 4;
  if (ev.hasHeat) audienceFit += 3;
  if (ev.hasExcerpt) audienceFit += 2;
  audienceFit = Math.min(25, audienceFit);
  if (audienceFit < 5 && (ev.hasSummary || ev.hasExcerpt)) audienceFit = 5;

  let viewpointRoom = 0;
  if (ev.hasExcerpt) {
    viewpointRoom = 6 + Math.floor(ev.excerptLen / 30) + (ev.hasSummary ? 2 : 0);
    if (ev.heatValue !== null && ev.heatValue > 10000) viewpointRoom += 2;
  } else if (ev.hasSummary) {
    viewpointRoom = 6 + Math.floor(ev.summaryLen / 60);
  }
  viewpointRoom = Math.min(20, viewpointRoom);
  if (duplicate) viewpointRoom = Math.min(viewpointRoom, 5);

  let evidenceAvailability = 0;
  if (ev.hasSummary && ev.hasExcerpt) {
    evidenceAvailability = 12 + Math.floor((ev.summaryLen + ev.excerptLen) / 80) + (ev.hasHeat ? 2 : 0);
  } else if (ev.hasSummary || ev.hasExcerpt) {
    evidenceAvailability = 8 + Math.floor((ev.summaryLen + ev.excerptLen) / 60);
  }
  if (ev.hasCategories) evidenceAvailability += 1;
  evidenceAvailability = Math.min(20, evidenceAvailability);

  let timelinessLifecycle = 0;
  if (ev.collectedAt) {
    const collected = Date.parse(ev.collectedAt);
    const now = Date.parse(nowIso);
    if (!Number.isNaN(collected) && !Number.isNaN(now)) {
      const diffDays = (now - collected) / (1000 * 60 * 60 * 24);
      if (diffDays <= 1) timelinessLifecycle = 15;
      else if (diffDays <= 3) timelinessLifecycle = 10;
      else if (diffDays <= 7) timelinessLifecycle = 6;
      else timelinessLifecycle = 3;
    } else {
      timelinessLifecycle = ev.hasSummary ? 6 : 3;
    }
  } else {
    timelinessLifecycle = ev.hasSummary ? 8 : 0;
  }

  let articleVideoTransfer = 0;
  if (ev.hasSummary) {
    articleVideoTransfer = 7 + Math.floor(ev.summaryLen / 80);
    if (rank !== null && rank <= 5) articleVideoTransfer += 1;
  } else if (ev.hasExcerpt) {
    articleVideoTransfer = 5 + Math.floor(ev.excerptLen / 80);
  }
  if (ev.hasHeat) articleVideoTransfer += 1;
  articleVideoTransfer = Math.min(15, articleVideoTransfer);

  let executionCost = 0;
  if (ev.canonicalUrl && ev.canonicalUrl.trim().length > 0) executionCost = 5;
  else if (ev.hasSummary || ev.hasExcerpt) executionCost = 3;
  executionCost = Math.min(5, executionCost);

  return {
    audienceFit: clampDim(audienceFit, ZHIHU_SCORING_DIMENSION_CAPS.audienceFit),
    viewpointRoom: clampDim(viewpointRoom, ZHIHU_SCORING_DIMENSION_CAPS.viewpointRoom),
    evidenceAvailability: clampDim(evidenceAvailability, ZHIHU_SCORING_DIMENSION_CAPS.evidenceAvailability),
    timelinessLifecycle: clampDim(timelinessLifecycle, ZHIHU_SCORING_DIMENSION_CAPS.timelinessLifecycle),
    articleVideoTransfer: clampDim(articleVideoTransfer, ZHIHU_SCORING_DIMENSION_CAPS.articleVideoTransfer),
    executionCost: clampDim(executionCost, ZHIHU_SCORING_DIMENSION_CAPS.executionCost),
  };
}

export function scoreCandidates(
  database: DatabaseSync,
  inputs: readonly ZhihuScoringInput[],
  nowIso = new Date().toISOString(),
  settingsOverride?: Partial<ZhihuScoringSettings>
): ZhihuScoredCandidate[] {
  const settings = settingsOverride
    ? validateScoringSettings({ ...getScoringSettings(database), ...settingsOverride })
    : getScoringSettings(database);
  const out: ZhihuScoredCandidate[] = [];
  for (const raw of inputs) {
    const canonicalUrl = raw.canonicalUrl ? (canonicalizeZhihuQuestionUrl(raw.canonicalUrl) ?? raw.canonicalUrl) : null;
    const evidence = fetchEvidenceFacts(database, raw.id);
    const dup = isDuplicateWithin30Days(database, canonicalUrl, raw.title, nowIso, raw.id);
    const hasNewValue = Boolean(raw.hasNewEvidence || raw.hasNewAudience || raw.hasNewViewpoint);
    const isDuplicateEffective = dup.duplicate && !hasNewValue;
    const hardRiskCodes = stableHardRisks(raw.hardRisks);
    const effectiveHardRisks: ZhihuHardRiskCode[] = hardRiskCodes.length ? [...hardRiskCodes] : [];
    if (isDuplicateEffective && !effectiveHardRisks.includes('duplicate_no_value')) effectiveHardRisks.push('duplicate_no_value');
    effectiveHardRisks.sort();

    const dims = computeEvidenceDrivenDims(evidence, raw.rank ?? null, dup.duplicate, nowIso);

    const total = dims.audienceFit + dims.viewpointRoom + dims.evidenceAvailability + dims.timelinessLifecycle + dims.articleVideoTransfer + dims.executionCost;

    let route: ZhihuScoredCandidate['route'];
    if (effectiveHardRisks.length) route = 'rejected';
    else if (total >= settings.autoThreshold) route = 'automatic';
    else if (total >= settings.boundaryThreshold) route = 'boundary';
    else route = 'rejected';
    if (dup.duplicate && hasNewValue && route === 'automatic') route = 'boundary';

    const proposalReason = proposalReasonFor({ total, hardRisks: effectiveHardRisks, duplicate: dup.duplicate, hasNewValue }, settings);

    const dimensionEvidence: Record<string, ZhihuDimensionEvidence> = {};
    const rawEvidence = raw.dimensionEvidence ?? {};
    for (const [k, v] of Object.entries(rawEvidence)) dimensionEvidence[k] = { evidence: v.evidence, reason: v.reason };

    const isInsufficient = !evidence.hasSummary && !evidence.hasExcerpt;
    dimensionEvidence['audienceFit'] = dimensionEvidence['audienceFit'] ?? {
      evidence: evidence.hasCategories ? `categories:${evidence.categories.join(',')}` : evidence.hasSummary ? 'summary present' : 'no categories/summary',
      reason: isInsufficient ? 'no_source_body_or_categories' : `audienceFit=${dims.audienceFit}/${ZHIHU_SCORING_DIMENSION_CAPS.audienceFit}`,
    };
    dimensionEvidence['viewpointRoom'] = dimensionEvidence['viewpointRoom'] ?? {
      evidence: evidence.hasExcerpt ? `excerpt:${evidence.excerptLen}ch` : 'no excerpt',
      reason: isInsufficient ? 'no_excerpt_for_viewpoint' : `viewpointRoom=${dims.viewpointRoom}/${ZHIHU_SCORING_DIMENSION_CAPS.viewpointRoom}`,
    };
    dimensionEvidence['evidenceAvailability'] = dimensionEvidence['evidenceAvailability'] ?? {
      evidence: evidence.hasSummary && evidence.hasExcerpt ? 'summary+excerpt' : evidence.hasSummary ? 'summary only' : evidence.hasExcerpt ? 'excerpt only' : 'no body',
      reason: isInsufficient ? 'no_source_body_or_claims' : `evidenceAvailability=${dims.evidenceAvailability}/${ZHIHU_SCORING_DIMENSION_CAPS.evidenceAvailability}`,
    };
    dimensionEvidence['timelinessLifecycle'] = dimensionEvidence['timelinessLifecycle'] ?? {
      evidence: evidence.collectedAt ?? 'no collected_at',
      reason: isInsufficient ? 'today_but_no_source_evidence' : `timelinessLifecycle=${dims.timelinessLifecycle}/${ZHIHU_SCORING_DIMENSION_CAPS.timelinessLifecycle}`,
    };
    dimensionEvidence['articleVideoTransfer'] = dimensionEvidence['articleVideoTransfer'] ?? {
      evidence: evidence.hasSummary ? `summaryLen:${evidence.summaryLen}` : evidence.hasExcerpt ? `excerptLen:${evidence.excerptLen}` : 'no body',
      reason: `articleVideoTransfer=${dims.articleVideoTransfer}/${ZHIHU_SCORING_DIMENSION_CAPS.articleVideoTransfer}`,
    };
    dimensionEvidence['executionCost'] = dimensionEvidence['executionCost'] ?? {
      evidence: evidence.canonicalUrl ?? 'no canonical',
      reason: `executionCost=${dims.executionCost}/${ZHIHU_SCORING_DIMENSION_CAPS.executionCost}`,
    };

    out.push({
      id: raw.id,
      canonicalUrl,
      title: raw.title,
      rank: raw.rank ?? null,
      total,
      dims,
      risks: [...effectiveHardRisks],
      hardRiskCodes: [...effectiveHardRisks],
      duplicate: dup.duplicate,
      duplicateReason: dup.reason,
      route,
      proposalReason,
      dimensionEvidence,
      rawInput: raw,
    });
  }
  out.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const ca = a.canonicalUrl ?? a.id;
    const cb = b.canonicalUrl ?? b.id;
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

export function selectWithQuota(scoredInRankOrder: readonly ZhihuScoredCandidate[], targetCount: number): ZhihuQuotaSelection {
  const automatic = scoredInRankOrder.filter((c) => c.route === 'automatic');
  const boundary = scoredInRankOrder.filter((c) => c.route === 'boundary');
  const rejected = scoredInRankOrder.filter((c) => c.route === 'rejected');
  const selected: ZhihuScoredCandidate[] = [];
  for (const c of automatic) {
    if (selected.length < targetCount) selected.push(c);
  }
  const remaining = Math.max(0, targetCount - selected.length);
  const visibleBoundary = [...boundary];
  const boundarySelected = visibleBoundary.slice(0, remaining);
  for (const c of boundarySelected) selected.push(c);
  return { automatic, boundary: visibleBoundary, rejected, selected, visibleBoundary };
}

export function scoreSnapshotJsonFor(candidate: ZhihuScoredCandidate): string {
  return JSON.stringify({
    total: candidate.total,
    audienceFit: candidate.dims.audienceFit,
    viewpointRoom: candidate.dims.viewpointRoom,
    evidenceAvailability: candidate.dims.evidenceAvailability,
    timelinessLifecycle: candidate.dims.timelinessLifecycle,
    articleVideoTransfer: candidate.dims.articleVideoTransfer,
    executionCost: candidate.dims.executionCost,
    risks: candidate.risks,
    hardRiskCodes: candidate.hardRiskCodes,
    duplicate: candidate.duplicate,
    duplicateReason: candidate.duplicateReason ?? null,
    route: candidate.route,
    proposalReason: candidate.proposalReason,
    dimensionEvidence: candidate.dimensionEvidence,
    canonicalUrl: candidate.canonicalUrl,
    rank: candidate.rank,
  });
}
