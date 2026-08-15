/**
 * WMB-5171 / CAP-028 §3/§4/§9：ResearchJob 持久化映射（自 agent-tasks.ts 迁出，
 * agent-tasks 仅保留 intent 数组与恢复 SQL 的既有职责）。
 * 不新增表/列：ResearchGap/预算/门槛/链 → context_refs_json（rebuildRoleJobRequest 重建）；
 * 预算计数 → progress_json；可恢复现场 → checkpoint_json；EvidencePack → result_refs_json。
 */

import { rebuildRoleJobRequest } from './job-object-boundary.ts';
import type { ResearchGap } from './role-job-registry.ts';
import type { ResearchClaimStatus } from './db/research-claims-store.ts';

export type ResearchProgress = Readonly<{
  planned?: number;
  processed?: number;
  verified?: number;
  saved?: number;
  message?: string;
}>;

export type ResearchCheckpoint = Readonly<{
  round: number;
  startedAt: string;
  budgetLeftMs: number;
  candidatesProcessed: number;
  claimsSnapshot: Readonly<Record<string, ResearchClaimStatus>>;
}>;

export type ResearchEvidencePackClaim = Readonly<{
  id: string;
  key: string;
  status: ResearchClaimStatus;
  verdictReason: string | null;
  evidenceSourceIds: readonly string[];
  needsTimeExcerpt: boolean;
}>;

export type ResearchEvidencePackTerminalReason = 'claims_resolved' | 'budget_exhausted' | 'candidates_exhausted' | 'aborted';

export type ResearchEvidencePack = Readonly<{
  kind: 'research_evidence';
  jobId: string;
  round: number;
  claims: readonly ResearchEvidencePackClaim[];
  sourceIds: readonly string[];
  validSourceCount: number;
  candidateCount: number;
  timeSpentMinutes: number;
  terminalReason: ResearchEvidencePackTerminalReason;
  unresolvedRequiredClaims: readonly string[];
}>;

/** research_claims 状态枚举（与 research-claims-store 表 CHECK 同源；运行时守卫用）。 */
const RESEARCH_CLAIM_STATUSES = Object.freeze(['pending', 'supported', 'contradicted', 'unresolved', 'source_unavailable'] as const);

function isResearchClaimStatus(value: unknown): value is ResearchClaimStatus {
  return typeof value === 'string' && (RESEARCH_CLAIM_STATUSES as readonly string[]).includes(value);
}

/**
 * WMB-5171：从 context_refs 读回已校验 ResearchGap（复用角色注册表真源 rebuildRoleJobRequest；
 * 损坏 research refs fail-closed → null，绝不静默降级为普通 reporter）。
 */
export function readResearchGap(contextRefs: Record<string, unknown>): ResearchGap | null {
  const request = rebuildRoleJobRequest(contextRefs);
  if (!request || request.roleId !== 'reporter' || !('research' in request)) return null;
  return request.research;
}

/** WMB-5171：progress_json 研究预算计数读回（fail-closed：非法形状 → null；预算机器执行不靠 prompt）。 */
type ResearchProgressBuilder = {
  planned?: number;
  processed?: number;
  verified?: number;
  saved?: number;
  message?: string;
};

export function parseResearchProgress(value: unknown): ResearchProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const progress: ResearchProgressBuilder = {};
  for (const key of ['planned', 'processed', 'verified', 'saved'] as const) {
    const n = record[key];
    if (n === undefined || n === null) continue;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
    progress[key] = n;
  }
  const message = record.message;
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') return null;
    progress.message = message;
  }
  return Object.freeze(progress);
}

/** WMB-5171：checkpoint_json 可恢复研究现场读回（fail-closed：非法形状 → null）。 */
export function parseResearchCheckpoint(value: unknown): ResearchCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const round = record.round;
  const startedAt = record.startedAt;
  const budgetLeftMs = record.budgetLeftMs;
  const candidatesProcessed = record.candidatesProcessed;
  const claimsSnapshot = record.claimsSnapshot;
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) return null;
  if (typeof startedAt !== 'string' || !startedAt) return null;
  if (typeof budgetLeftMs !== 'number' || !Number.isFinite(budgetLeftMs) || budgetLeftMs < 0) return null;
  if (typeof candidatesProcessed !== 'number' || !Number.isInteger(candidatesProcessed) || candidatesProcessed < 0) return null;
  if (!claimsSnapshot || typeof claimsSnapshot !== 'object' || Array.isArray(claimsSnapshot)) return null;
  const snapshot: Record<string, ResearchClaimStatus> = {};
  for (const [claimKey, status] of Object.entries(claimsSnapshot as Record<string, unknown>)) {
    if (!claimKey || !isResearchClaimStatus(status)) return null;
    snapshot[claimKey] = status;
  }
  return Object.freeze({ round, startedAt, budgetLeftMs, candidatesProcessed, claimsSnapshot: Object.freeze(snapshot) });
}

/** WMB-5171：checkpoint 写入构造（复用 parse 校验，非法输入拒绝写入——恢复现场必须可机器重建）。 */
export function buildResearchCheckpoint(input: {
  round: number;
  startedAt: string;
  budgetLeftMs: number;
  candidatesProcessed: number;
  claimsSnapshot: Record<string, ResearchClaimStatus>;
}): ResearchCheckpoint {
  const checkpoint = parseResearchCheckpoint(input);
  if (!checkpoint) throw new Error('WMB-5171: 研究检查点形状非法，拒绝写入 checkpoint_json。');
  return checkpoint;
}

/** WMB-5171：result_refs_json EvidencePack 读回（fail-closed：非 research_evidence 或非法形状 → null）。 */
export function parseResearchEvidencePack(value: unknown): ResearchEvidencePack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'research_evidence') return null;
  const jobId = record.jobId;
  const round = record.round;
  const claims = record.claims;
  const sourceIds = record.sourceIds;
  const validSourceCount = record.validSourceCount;
  const candidateCount = record.candidateCount;
  const timeSpentMinutes = record.timeSpentMinutes;
  const terminalReason = record.terminalReason;
  const unresolvedRequiredClaims = record.unresolvedRequiredClaims;
  if (typeof jobId !== 'string' || !jobId) return null;
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) return null;
  if (!Array.isArray(claims)) return null;
  const parsedClaims: ResearchEvidencePackClaim[] = [];
  for (const item of claims) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const claim = item as Record<string, unknown>;
    const id = claim.id;
    const key = claim.key;
    const status = claim.status;
    const verdictReason = claim.verdictReason;
    const evidenceSourceIds = claim.evidenceSourceIds;
    const needsTimeExcerpt = claim.needsTimeExcerpt;
    if (typeof id !== 'string' || !id) return null;
    if (typeof key !== 'string' || !key) return null;
    if (!isResearchClaimStatus(status)) return null;
    if (verdictReason !== undefined && verdictReason !== null && typeof verdictReason !== 'string') return null;
    if (!Array.isArray(evidenceSourceIds) || evidenceSourceIds.some((sourceId) => typeof sourceId !== 'string')) return null;
    if (typeof needsTimeExcerpt !== 'boolean') return null;
    parsedClaims.push(Object.freeze({
      id,
      key,
      status,
      verdictReason: typeof verdictReason === 'string' ? verdictReason : null,
      evidenceSourceIds: Object.freeze([...evidenceSourceIds]),
      needsTimeExcerpt
    }));
  }
  if (!Array.isArray(sourceIds) || sourceIds.some((sourceId) => typeof sourceId !== 'string')) return null;
  if (typeof validSourceCount !== 'number' || !Number.isInteger(validSourceCount) || validSourceCount < 0) return null;
  if (typeof candidateCount !== 'number' || !Number.isInteger(candidateCount) || candidateCount < 0) return null;
  if (typeof timeSpentMinutes !== 'number' || !Number.isFinite(timeSpentMinutes) || timeSpentMinutes < 0) return null;
  if (terminalReason !== 'claims_resolved' && terminalReason !== 'budget_exhausted'
    && terminalReason !== 'candidates_exhausted' && terminalReason !== 'aborted') return null;
  if (!Array.isArray(unresolvedRequiredClaims) || unresolvedRequiredClaims.some((claimKey) => typeof claimKey !== 'string')) return null;
  return Object.freeze({
    kind: 'research_evidence',
    jobId,
    round,
    claims: Object.freeze(parsedClaims),
    sourceIds: Object.freeze([...sourceIds]),
    validSourceCount,
    candidateCount,
    timeSpentMinutes,
    terminalReason,
    unresolvedRequiredClaims: Object.freeze([...unresolvedRequiredClaims])
  });
}

/** WMB-5171：EvidencePack 写入构造（复用 parse 校验，非法形状拒绝写入 result_refs_json）。 */
export function buildResearchEvidencePack(input: {
  jobId: string;
  round: number;
  claims: readonly ResearchEvidencePackClaim[];
  sourceIds: readonly string[];
  validSourceCount: number;
  candidateCount: number;
  timeSpentMinutes: number;
  terminalReason: ResearchEvidencePackTerminalReason;
  unresolvedRequiredClaims: readonly string[];
}): ResearchEvidencePack {
  const pack = parseResearchEvidencePack({ kind: 'research_evidence', ...input });
  if (!pack) throw new Error('WMB-5171: EvidencePack 形状非法，拒绝写入 result_refs_json。');
  return pack;
}
