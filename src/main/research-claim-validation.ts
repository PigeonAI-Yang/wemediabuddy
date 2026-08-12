/**
 * WMB-5172 / CAP-028 §5 / 设计 §5.4：claim 机器校验（纯函数，无 I/O）。
 * 系统侧推导、fail-closed：记者只提结构化建议 {claimKey,status,evidenceSourceIds,verdictReason}，
 * 硬门槛在代码不在 prompt。校验失败一律降级 `unresolved`（reason `threshold_not_met`）；
 * `source_unavailable` 仅在该 claim 全部候选源读取失败时由机器推导。
 */

import type { ResearchClaimStatus, ResearchClaimType } from './db/research-claims-store.ts';

export type ResearchEvidenceSourceKind = 'official' | 'secondary';

/** 一条可核验证据（title/originalUrl/author/summary 为机器可核验字段；"官方/一手"语义由记者声明，机器校验结构门槛）。 */
export type ResearchEvidenceItem = Readonly<{
  sourceId: string;
  claimKey: string;
  url: string;
  title: string;
  author: string;
  summary: string;
  publishedAt?: string | null;
  collectedAt?: string | null;
  excerpt?: string | null;
  sourceKind: ResearchEvidenceSourceKind;
}>;

export type ResearchClaimProposal = Readonly<{
  claimKey: string;
  status: ResearchClaimStatus;
  evidenceSourceIds: readonly string[];
  verdictReason?: string | null;
}>;

export type ResearchClaimValidationContext = Readonly<{
  claimKey: string;
  claimType: ResearchClaimType;
  /** 本任务已核验证据，按 sourceId 索引。 */
  evidence: ReadonlyMap<string, ResearchEvidenceItem>;
  /** 该 claim 已处理候选数。 */
  candidateTotal: number;
  /** 该 claim 未成为可评估证据的候选数（读取失败/写回拒绝/字段缺失）。 */
  candidateFailed: number;
  /** 读取失败的主导原因（auth_required / network / timeout …）。 */
  failureReason?: string | null;
}>;

export type ResearchClaimVerdict = Readonly<{ status: ResearchClaimStatus; verdictReason: string }>;

/** canonical URL 域名（独立代理判定：两源域名互异 = 独立）。 */
export function evidenceDomainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** canonical 去重键：默认 https、host 小写、去 fragment 与尾斜杠。 */
export function canonicalUrlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'https:';
    parsed.hash = '';
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    parsed.pathname = path;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function hasVerifiableFields(item: ResearchEvidenceItem): boolean {
  return Boolean(item.title?.trim() && item.url?.trim() && item.author?.trim() && item.summary?.trim());
}

export function evidenceHasTime(item: ResearchEvidenceItem): boolean {
  return Boolean(item.publishedAt?.trim() || item.collectedAt?.trim());
}

export function evidenceHasExcerpt(item: ResearchEvidenceItem): boolean {
  return Boolean(item.excerpt?.trim());
}

export type EvidenceThreshold = Readonly<{ passes: boolean; reason: string | null }>;

/**
 * 支持门槛（§5.4 / R6）：≥1 官方/一手源，或 ≥2 独立可靠二手源（canonical URL 域互异）；
 * type ∈ {price, policy} 时每条支撑证据必须带时间（publishedAt/collectedAt）+ 摘录（verbatim excerpt）。
 */
export function assessSupportThreshold(items: readonly ResearchEvidenceItem[], claimType: ResearchClaimType): EvidenceThreshold {
  if (!items.length) return { passes: false, reason: 'insufficient_evidence' };
  for (const item of items) {
    if (!hasVerifiableFields(item)) return { passes: false, reason: 'missing_verifiable_fields' };
  }
  if (claimType === 'price' || claimType === 'policy') {
    for (const item of items) {
      if (!evidenceHasTime(item)) return { passes: false, reason: 'missing_time' };
      if (!evidenceHasExcerpt(item)) return { passes: false, reason: 'missing_excerpt' };
    }
  }
  if (items.some((item) => item.sourceKind === 'official')) return { passes: true, reason: 'official_source' };
  const secondaries = items.filter((item) => item.sourceKind === 'secondary');
  if (secondaries.length >= 2) {
    const domains = new Set<string>();
    for (const item of secondaries) {
      const domain = evidenceDomainOf(item.url);
      if (domain) domains.add(domain);
    }
    if (domains.size >= 2) return { passes: true, reason: 'two_independent_secondary' };
    return { passes: false, reason: 'not_independent_domains' };
  }
  return { passes: false, reason: 'insufficient_secondary' };
}

export function isTerminalResearchStatus(status: ResearchClaimStatus | undefined): boolean {
  return status === 'supported' || status === 'contradicted' || status === 'unresolved' || status === 'source_unavailable';
}

export function isUnresolvedResearchStatus(status: ResearchClaimStatus | undefined): boolean {
  return status === 'unresolved' || status === 'source_unavailable';
}

/** 未解决 required claim 键列表（EvidencePack.unresolvedRequiredClaims）。 */
export function unresolvedRequiredClaimKeys(statuses: Readonly<Record<string, ResearchClaimStatus>>, claimKeys: readonly string[]): string[] {
  return claimKeys.filter((key) => isUnresolvedResearchStatus(statuses[key]));
}

/**
 * claim 判定机器校验（fail-closed）：
 * - 全部候选读取失败且无任何可评估材料 → source_unavailable（机器推导，优先于建议）。
 * - 无建议 → unresolved（no_proposal）。
 * - 建议 supported/contradicted：支撑证据达门槛 → 采纳；未达 → unresolved（threshold_not_met）。
 * - 建议 source_unavailable 但非全部失败 → unresolved（threshold_not_met）。
 * - 建议 unresolved → 采纳（机器不替记者升级）。
 */
export function validateClaimProposal(ctx: ResearchClaimValidationContext, proposal: ResearchClaimProposal | null): ResearchClaimVerdict {
  const allCandidatesFailed = ctx.candidateTotal > 0 && ctx.candidateFailed >= ctx.candidateTotal;
  const items = (proposal?.evidenceSourceIds ?? [])
    .map((sourceId) => ctx.evidence.get(sourceId))
    .filter((item): item is ResearchEvidenceItem => Boolean(item));

  if (allCandidatesFailed && items.length === 0) {
    return { status: 'source_unavailable', verdictReason: ctx.failureReason?.trim() || 'unavailable' };
  }
  if (!proposal) return { status: 'unresolved', verdictReason: 'no_proposal' };

  switch (proposal.status) {
    case 'supported': {
      const threshold = assessSupportThreshold(items, ctx.claimType);
      if (!threshold.passes) return { status: 'unresolved', verdictReason: 'threshold_not_met' };
      return { status: 'supported', verdictReason: proposal.verdictReason?.trim() || threshold.reason || 'evidence_threshold_met' };
    }
    case 'contradicted': {
      const threshold = assessSupportThreshold(items, ctx.claimType);
      if (!threshold.passes) return { status: 'unresolved', verdictReason: 'threshold_not_met' };
      return { status: 'contradicted', verdictReason: proposal.verdictReason?.trim() || threshold.reason || 'evidence_threshold_met' };
    }
    case 'source_unavailable':
      return { status: 'unresolved', verdictReason: 'threshold_not_met' };
    case 'unresolved':
      return { status: 'unresolved', verdictReason: proposal.verdictReason?.trim() || 'unresolved' };
    default:
      return { status: 'unresolved', verdictReason: 'threshold_not_met' };
  }
}
