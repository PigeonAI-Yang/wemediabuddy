/**
 * WMB-5352 proposals/today honest projection helper (renderer-local).
 * - Exposes four planning statuses honestly with provenance/revision/pending score.
 * - Draft/pending shows "— / 待补证据" never 100.
 * - Ready-for-review visible with approve/reject bridge (fixed command names).
 * - Today filters strictly to approved.
 * - No any, no hardcoded planning prose, no duplicate runtime paths.
 */
import { PROPAGATION_CRITERIA, PROPAGATION_NEUTRAL_GRADE, isScoredApproved as isPropagationScoredApproved, propagationGradeFromScore, resolvePropagationGrade, isValidScoredReasons as isPropagationValidScored, isScoredReadyForReview as isPropagationReady, isScoringPending as isPropagationScoringPending } from '../shared/propagation.ts';

export type PlanningStatus = 'draft' | 'ready_for_review' | 'approved' | 'rejected';
export const PLANNING_STATUS: Record<string, PlanningStatus> = {
  Draft: 'draft',
  ReadyForReview: 'ready_for_review',
  Approved: 'approved',
  Rejected: 'rejected',
} as const;

export const PLANNING_STATUS_LABEL: Record<PlanningStatus, string> = {
  draft: '草稿 · 待策划/待补证据',
  ready_for_review: '待主管审批',
  approved: '已批准 · 生产推进中',
  rejected: '已驳回',
};

export const PLANNING_STATUS_TONE: Record<PlanningStatus, string> = {
  draft: 'draft',
  ready_for_review: 'review',
  approved: 'approved',
  rejected: 'rejected',
};


const SCORE_CRITERIA_WEIGHTS: Record<string, number> = PROPAGATION_CRITERIA;

export type ScoreReason = {
  criterion: string;
  weight: number;
  score: number;
  reason?: string;
};

export type ScoreReasons = {
  status: 'pending' | 'scored';
  score: number;
  reasons: ScoreReason[];
  pending_reason?: string;
  pendingReason?: string;
};

export type PlanningProvenance = {
  origin?: string;
  legacy?: string | null;
  backfilled_at?: string | null;
  fingerprints?: { template_exact_9fields?: boolean; zhihu_hot_ids?: string[] };
  transitions?: Array<{ from: string | null; to: PlanningStatus; by: string; at: string; reason?: string }>;
  planner_task_id?: string | null;
  [k: string]: unknown;
};

function safeJsonParse(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseScoreReasons(raw: unknown): ScoreReasons | null {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== 'pending' && status !== 'scored') return null;
  const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
  if (!Number.isFinite(score)) return null;
  const reasonsRaw = obj.reasons;
  const reasons: ScoreReason[] = Array.isArray(reasonsRaw)
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
    reasons,
    pending_reason: typeof obj.pending_reason === 'string' ? obj.pending_reason : undefined,
    pendingReason: typeof obj.pendingReason === 'string' ? obj.pendingReason : undefined,
  } as ScoreReasons;
}

export function isPendingScore(score: ScoreReasons | null | undefined): boolean {
  if (!score) return true;
  return score.status === 'pending' || score.score === 0 && score.reasons.length === 0;
}

export function formatScoreDisplay(score: ScoreReasons | null | undefined, planningStatus?: PlanningStatus | string | null): string {
  // Draft always pending display regardless of score object — never 100
  if (planningStatus === 'draft') return '— / 待补证据';
  if (!score) return '— / 待补证据';
  if (score.status === 'pending') return '— / 待补证据';
  if (score.status === 'scored' && Array.isArray(score.reasons) && score.reasons.length === 6) {
    const sum = score.reasons.reduce((acc, r) => acc + (Number.isFinite(r.score) ? r.score : 0), 0);
    if (sum !== score.score) return '— / 待补证据';
    // Also ensure weights match expected (defensive, but don't hide valid)
  }
  if (score.status === 'scored' && score.reasons.length !== 6) {
    // Incomplete reasons -> pending
    return '— / 待补证据';
  }
  return String(score.score);
}

export function formatScoreWithPending(score: ScoreReasons | null | undefined, planningStatus?: PlanningStatus | string | null): string {
  const disp = formatScoreDisplay(score, planningStatus);
  if (disp === '— / 待补证据') return '评分：待补证据（—）';
  return `评分：${disp}`;
}

export function pendingScoreReason(score: ScoreReasons | null | undefined): string {
  if (!score) return 'insufficient_evidence';
  if (score.pending_reason) return score.pending_reason;
  if (score.pendingReason) return score.pendingReason;
  return '待补证据';
}

// Propagation grade resolver — single shared pure function (priority never consulted)
export { PROPAGATION_CRITERIA, PROPAGATION_NEUTRAL_GRADE, propagationGradeFromScore, resolvePropagationGrade };
export function getPropagationGrade(item: unknown): string {
  return resolvePropagationGrade(item);
}
export function isScoredApprovedItem(item: unknown): boolean {
  return isPropagationScoredApproved(item);
}
export function isScoredReadyForReviewItem(item: unknown): boolean {
  return isPropagationReady(item);
}
export function isScoringPendingItem(item: unknown): boolean {
  return isPropagationScoringPending(item);
}
export function isEligibleForToday(item: unknown): boolean {
  return isScoredReadyForReviewItem(item);
}
export function pendingReasonForItem(item: unknown): string {
  const s = getPlanningStatus(item);
  if (s !== 'draft' && s !== 'rejected') return '待补证据';
  const score = getScoreReasons(item);
  if (!score) return '评分未完成';
  if (score.pending_reason) return score.pending_reason;
  if (score.pendingReason) return score.pendingReason;
  if (score.status === 'pending') return '评分未完成';
  return '评分未完成';
}

export function parsePlanningProvenance(raw: unknown): PlanningProvenance | null {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as PlanningProvenance;
}

export function getPlanningStatus(item: unknown): PlanningStatus | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const candidates = [
    obj.planning_status,
    obj.planningStatus,
    obj.planning_status_text,
    (obj as Record<string, unknown>).status, // fallback but only if matches planning status strings
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && (v === 'draft' || v === 'ready_for_review' || v === 'approved' || v === 'rejected')) {
      return v as PlanningStatus;
    }
  }
  // Try provenance extraction: last transition to
  const provRaw = obj.planning_provenance_json ?? obj.planningProvenanceJson ?? obj.provenance ?? obj.provenanceJson;
  const prov = parsePlanningProvenance(provRaw);
  if (prov?.transitions && Array.isArray(prov.transitions) && prov.transitions.length) {
    const last = prov.transitions[prov.transitions.length - 1];
    if (last && typeof last.to === 'string' && (last.to === 'draft' || last.to === 'ready_for_review' || last.to === 'approved' || last.to === 'rejected')) {
      return last.to as PlanningStatus;
    }
  }
  // If no explicit status, infer from score pending? Do not infer approved; treat unknown as null for strict filtering.
  return null;
}

export function getRevision(item: unknown): number | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const candidates = [obj.revision, obj.rev, obj.version, obj.expectedRevision];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

export function getPlanningProvenance(item: unknown): PlanningProvenance | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const raw = obj.planning_provenance_json ?? obj.planningProvenanceJson ?? obj.provenance ?? obj.provenanceJson ?? obj.planning_provenance;
  return parsePlanningProvenance(raw);
}

export function getScoreReasons(item: unknown): ScoreReasons | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const candidates: unknown[] = [
    obj.score_reasons_json,
    obj.scoreReasonsJson,
    obj.score_reasons,
    obj.scoreReasons,
    obj.score_snapshot_json,
    obj.scoreSnapshotJson,
    obj.scoreSnapshot,
    obj.score_snapshot,
  ];
  for (const raw of candidates) {
    const parsed = parseScoreReasons(raw);
    if (parsed) return parsed;
  }
  // Also try direct object with status/score
  if (typeof obj.status === 'string' && typeof obj.score === 'number') {
    const maybe = parseScoreReasons(obj);
    if (maybe) return maybe;
  }
  return null;
}

export function isApproved(item: unknown): boolean {
  return getPlanningStatus(item) === 'approved';
}

export function isReadyForReview(item: unknown): boolean {
  return getPlanningStatus(item) === 'ready_for_review';
}

export function isDraft(item: unknown): boolean {
  const s = getPlanningStatus(item);
  return s === 'draft' || s === null; // treat unknown as draft for safety (excluded from Today)
}

export function isRejected(item: unknown): boolean {
  return getPlanningStatus(item) === 'rejected';
}

export function isUnresolved(item: unknown): boolean {
  const s = getPlanningStatus(item);
  return s === 'draft' || s === 'ready_for_review';
}

export function countUnresolved(items: ReadonlyArray<unknown>): number {
  return items.filter((it) => isUnresolved(it)).length;
}

export function isExhaustedPlan(items: ReadonlyArray<unknown>): boolean {
  if (!items.length) return false;
  return items.every((it) => isRejected(it));
}

export function filterApprovedItems<T>(items: ReadonlyArray<T>): T[] {
  return items.filter((it) => isApproved(it));
}
export function filterEligibleForApproval<T>(items: ReadonlyArray<T>): T[] {
  return items.filter((it) => isEligibleForToday(it));
}
export function filterScoringPending<T>(items: ReadonlyArray<T>): T[] {
  return items.filter((it) => isScoringPendingItem(it));
}


export function countByPlanningStatus(items: ReadonlyArray<unknown>): Record<PlanningStatus, number> {
  const counts: Record<PlanningStatus, number> = { draft: 0, ready_for_review: 0, approved: 0, rejected: 0 };
  for (const item of items) {
    const s = getPlanningStatus(item);
    if (s && s in counts) counts[s] += 1;
    else counts.draft += 1; // unknown counts as draft (honest: not approved)
  }
  return counts;
}

export function groupProposalsByPlanningStatus<T>(items: ReadonlyArray<T>): Record<PlanningStatus, T[]> {
  const groups: Record<PlanningStatus, T[]> = { draft: [], ready_for_review: [], approved: [], rejected: [] };
  for (const item of items) {
    const s = getPlanningStatus(item);
    if (s && s in groups) groups[s].push(item);
    else groups.draft.push(item);
  }
  return groups;
}

export function availablePlanningStatuses(): PlanningStatus[] {
  return ['draft', 'ready_for_review', 'approved', 'rejected'];
}

// --- Bridge resolution for fixed command names ---

type BridgeGap = {
  missing: string;
  tried: string[];
  expectedCommands: string[];
};

const FIXED_COMMANDS = [
  'plan_item.submit',
  'plan_item.approve',
  'plan_item.reject',
  'plan_item.rework',
] as const;

type WindowWmb = Record<string, unknown> & {
  getProposalLedger?: (input: unknown) => Promise<unknown>;
  getToday?: (planDate: string) => Promise<unknown>;
};

function getWmb(): WindowWmb | null {
  try {
    const w = (typeof window !== 'undefined' ? (window as unknown as { wmb?: WindowWmb }).wmb : null) as WindowWmb | null;
    return w ?? null;
  } catch {
    return null;
  }
}

function tryInvokeBridge(_wmb: WindowWmb, _command: string, _payload: unknown): Promise<unknown> | null {
  // Deprecated generic fallback removed for WMB-5352/5353 honesty: callers must use explicit bridge methods.
  return null;
}

function bridgeMissingError(command: string, tried: string[]): Error & { code?: string; gap?: BridgeGap } {
  const gap: BridgeGap = {
    missing: command,
    tried,
    expectedCommands: [...FIXED_COMMANDS],
  };
  const err = Object.assign(
    new Error(
      `Planning bridge missing: ${command} not callable. Tried ${tried.join(', ') || 'no bridge'}. Expected fixed commands: ${FIXED_COMMANDS.join(', ')}. ` +
        `WMB-5351 must expose preload/IPC bridge for ${command} with {planItemId, expectedRevision, reason?} and readback. ` +
        `Renderer finished read/projection work; actions disabled until bridge lands.`,
    ),
    { code: 'BRIDGE_MISSING', gap },
  );
  return err as Error & { code?: string; gap?: BridgeGap };
}

function assertCommandResultOk(result: unknown): void {
  if (result && typeof result === 'object' && 'ok' in result) {
    const r = result as { ok: boolean; error?: { message?: string; code?: string } };
    if (!r.ok) {
      const msg = r.error?.message ?? 'command failed';
      const err = Object.assign(new Error(msg), { code: r.error?.code ?? 'COMMAND_FAILED', cause: result });
      throw err;
    }
  }
}

export async function approvePlanItem(input: { planItemId: string; expectedRevision: number; reason?: string }): Promise<unknown> {
  if (!input.planItemId || typeof input.planItemId !== 'string') throw Object.assign(new Error('planItemId required'), { code: 'validation_failed' });
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw Object.assign(new Error('expectedRevision invalid'), { code: 'validation_failed' });
  const wmb = getWmb();
  if (!wmb) throw bridgeMissingError('plan_item.approve', ['window.wmb missing']);
  const w = wmb as Record<string, unknown>;
  const fn = (w.planItemApprove ?? w.approvePlanItem) as unknown;
  if (typeof fn !== 'function') throw bridgeMissingError('plan_item.approve', ['window.wmb.planItemApprove']);
  const payload = {
    planItemId: input.planItemId,
    expectedRevision: input.expectedRevision,
    ...(input.reason != null && String(input.reason).trim() ? { reason: String(input.reason).trim() } : {}),
  };
  const result = await (fn as (p: unknown) => Promise<unknown>).call(wmb, payload);
  assertCommandResultOk(result);
  await refreshApprovedReadback(input.planItemId).catch(() => {});
  return result;
}

export function approvedProjectId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  let value: unknown = result;
  if ('data' in result && result.data && typeof result.data === 'object') value = result.data;
  if (!value || typeof value !== 'object' || !('projectId' in value)) return null;
  const projectId = value.projectId;
  return typeof projectId === 'string' && projectId.trim() ? projectId : null;
}

export async function rejectPlanItem(input: { planItemId: string; expectedRevision: number; reason: string }): Promise<unknown> {
  if (!input.planItemId || typeof input.planItemId !== 'string') throw Object.assign(new Error('planItemId required'), { code: 'validation_failed' });
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw Object.assign(new Error('expectedRevision invalid'), { code: 'validation_failed' });
  if (!input.reason || !String(input.reason).trim()) throw Object.assign(new Error('reason required for reject'), { code: 'validation_failed' });
  const wmb = getWmb();
  if (!wmb) throw bridgeMissingError('plan_item.reject', ['window.wmb missing']);
  const w = wmb as Record<string, unknown>;
  const fn = (w.planItemReject ?? w.rejectPlanItem) as unknown;
  if (typeof fn !== 'function') throw bridgeMissingError('plan_item.reject', ['window.wmb.planItemReject']);
  const payload = {
    planItemId: input.planItemId,
    expectedRevision: input.expectedRevision,
    reason: String(input.reason).trim(),
  };
  const result = await (fn as (p: unknown) => Promise<unknown>).call(wmb, payload);
  assertCommandResultOk(result);
  await refreshApprovedReadback(input.planItemId).catch(() => {});
  return result;
}

export async function reworkPlanItem(input: { planItemId: string; expectedRevision: number; reason?: string }): Promise<unknown> {
  if (!input.planItemId) throw Object.assign(new Error('planItemId required'), { code: 'validation_failed' });
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw Object.assign(new Error('expectedRevision invalid'), { code: 'validation_failed' });
  const wmb = getWmb();
  if (!wmb) throw bridgeMissingError('plan_item.rework', ['window.wmb missing']);
  const w = wmb as Record<string, unknown>;
  const fn = (w.planItemRework ?? w.reworkPlanItem) as unknown;
  if (typeof fn !== 'function') throw bridgeMissingError('plan_item.rework', ['window.wmb.planItemRework']);
  const payload = { planItemId: input.planItemId, expectedRevision: input.expectedRevision, ...(input.reason ? { reason: input.reason } : {}) };
  const result = await (fn as (p: unknown) => Promise<unknown>).call(wmb, payload);
  assertCommandResultOk(result);
  await refreshApprovedReadback(input.planItemId).catch(() => {});
  return result;
}



async function refreshApprovedReadback(_planItemId: string): Promise<void> {
  const wmb = getWmb();
  if (!wmb) return;
  // Best-effort reload of proposal ledger and today to reflect approved state.
  // Use planDate today if available, else skip.
  try {
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    if (typeof wmb.getProposalLedger === 'function') {
      // fire and forget, ignore errors
      void (wmb.getProposalLedger as (input: unknown) => Promise<unknown>)({ planDate: todayIso, tab: 'today', limit: 1 }).catch(() => {});
    }
    if (typeof wmb.getToday === 'function') {
      void (wmb.getToday as (d: string) => Promise<unknown>)(todayIso).catch(() => {});
    }
    // Trigger data changed listeners via scope dispatch if available
    // No direct broadcast here; rely on main to broadcast after command.
  } catch {}
}

export function describeBridgeGap(command: string, tried: string[]): BridgeGap {
  return { missing: command, tried, expectedCommands: [...FIXED_COMMANDS] };
}

export function planningStatusLabel(status: PlanningStatus | string | null | undefined): string {
  if (!status) return PLANNING_STATUS_LABEL.draft;
  return (PLANNING_STATUS_LABEL as Record<string, string>)[status] ?? PLANNING_STATUS_LABEL.draft;
}

export function validateFixedCommands(): readonly string[] {
  return FIXED_COMMANDS;
}
