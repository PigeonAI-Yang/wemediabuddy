/** WMB-5172 ResearchJob: hard budgets, durable resume, idempotent source writes, machine claim validation and EvidencePack. */

import { createHash } from 'node:crypto';
import { agentRequestId } from './agent-tasks.ts';
import { canonicalizeUrl } from './sources.ts';
import type { ResearchBudget, ResearchGap, ResearchRequiredClaim } from './role-job-registry.ts';
import type { ResearchClaimStatus } from './db/research-claims-store.ts';
import {
  buildResearchCheckpoint,
  buildResearchEvidencePack,
  parseResearchCheckpoint,
  parseResearchProgress,
  type ResearchCheckpoint,
  type ResearchEvidencePack,
  type ResearchEvidencePackTerminalReason,
  type ResearchProgress
} from './research-task-state.ts';
import {
  isTerminalResearchStatus,
  validateClaimProposal,
  type ResearchClaimProposal,
  type ResearchEvidenceItem
} from './research-claim-validation.ts';

/** 深度档硬默认（本次唯一档位；gap.budget 缺省/非法时回落）。 */
export const RESEARCH_DEFAULT_BUDGET = Object.freeze({
  timeMinutes: 12,
  minValidSources: 15,
  maxCandidates: 40,
  maxParallelFetches: 3,
  maxRounds: 1
});

export type ResearchCandidate = Readonly<{
  key: string;
  claimKey: string;
  url: string;
  title?: string | null;
  author?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  excerpt?: string | null;
  sourceKind: 'official' | 'secondary';
  /** X/XHS 等已读渠道候选：正文随结构化输出内联，跳过机器抓取。 */
  inlineText?: string | null;
}>;

export type ResearchFetchResult =
  | Readonly<{ ok: true; text: string; title?: string | null; publishedAt?: string | null }>
  | Readonly<{ ok: false; reason: string }>;

export type ResearchSourceWriteInput = Readonly<{
  claimKey: string;
  candidateKey: string;
  url: string;
  title: string;
  author: string;
  summary: string;
  publishedAt?: string | null;
  excerpt?: string | null;
  sourceKind: 'official' | 'secondary';
  requestId: string;
}>;

export type ResearchSourceWriteResult = Readonly<{ sourceId: string; created: boolean }>;

export type ResearchPersistedClaim = Readonly<{
  id: string;
  claimKey: string;
  status: ResearchClaimStatus;
  verdictReason: string | null;
  evidenceSourceIds: readonly string[];
  needsTimeExcerpt: boolean;
}>;

export type ResearchRunnerDeps = Readonly<{
  now(): Date;
  discoverCandidates(gap: ResearchGap, options: { maxCandidates: number; timeLeftMs: number }): Promise<readonly ResearchCandidate[]>;
  fetchCandidate(candidate: ResearchCandidate, options: { deadlineMs: number }): Promise<ResearchFetchResult>;
  writeSource(input: ResearchSourceWriteInput): Promise<ResearchSourceWriteResult | null>;
  proposeClaims(input: {
    claims: readonly ResearchRequiredClaim[];
    evidenceByClaim: Readonly<Record<string, readonly ResearchEvidenceItem[]>>;
    timeLeftMs: number;
  }): Promise<readonly ResearchClaimProposal[]>;
  persistProgress(input: {
    planned: number;
    processed: number;
    verified: number;
    saved: number;
    checkpoint: ResearchCheckpoint;
    message?: string;
  }): Promise<void>;
  persistClaims(input: readonly {
    claimKey: string;
    claimText: string;
    claimType: ResearchRequiredClaim['type'];
    status: ResearchClaimStatus;
    verdictReason: string;
    evidenceSourceIds: readonly string[];
    verifiedAt: string;
  }[]): Promise<void>;
  listSourceWriteReceipts?(): Promise<readonly Readonly<{ sourceId: string; created: boolean }>[] >;
  listClaims(): Promise<readonly ResearchPersistedClaim[]>;
}>;

export type ResearchJobRunInput = Readonly<{
  task: Readonly<{
    id: string;
    businessDate: string;
    contextRefs: Record<string, unknown>;
    checkpoint: Record<string, unknown>;
    progress: Record<string, unknown>;
  }>;
  gap: ResearchGap;
  signal: AbortSignal;
}>;

export type ResearchJobRunResult = Readonly<{
  terminal: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  failure?: Readonly<{ code: string; message: string }>;
  pack: ResearchEvidencePack | null;
  progress: ResearchProgress;
  checkpoint: ResearchCheckpoint;
  claimStatuses: Readonly<Record<string, ResearchClaimStatus>>;
}>;

/** 硬默认逐键回落：gap.budget 缺省/非正数时使用固定默认档位值。 */
export function resolveResearchBudget(budget: ResearchBudget | undefined): ResearchBudget {
  const pick = (key: keyof ResearchBudget, fallback: number): number => {
    const value = budget?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    timeMinutes: pick('timeMinutes', RESEARCH_DEFAULT_BUDGET.timeMinutes),
    minValidSources: pick('minValidSources', RESEARCH_DEFAULT_BUDGET.minValidSources),
    maxCandidates: pick('maxCandidates', RESEARCH_DEFAULT_BUDGET.maxCandidates),
    maxParallelFetches: pick('maxParallelFetches', RESEARCH_DEFAULT_BUDGET.maxParallelFetches),
    maxRounds: pick('maxRounds', RESEARCH_DEFAULT_BUDGET.maxRounds)
  };
}

/** canonical URL → 稳定数字键（SHA-256 截断 48-bit）：同 URL 恒同键、互异 URL 键互异，跨重启/乱序稳定。 */
export function researchSourceKeyFor(url: string): number {
  let canonical: string;
  try { canonical = canonicalizeUrl(url); } catch { canonical = url.trim(); }
  return createHash('sha256').update(canonical, 'utf8').digest().readUIntBE(0, 6);
}

function snippetOf(text: string, limit = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/** 从会话文本提取最后一个 ```json 块（对齐 daily 结构化输出路径）。 */
export function extractLastJsonBlock(output: string | null | undefined): string | null {
  if (!output) return null;
  let last: string | null = null;
  for (const match of output.matchAll(/```json\s*([\s\S]*?)```/g)) {
    const body = match[1].trim();
    if (body) last = body;
  }
  return last;
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  return value === undefined || value === null ? null : typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 结构化输出 → 候选清单（fail-closed：整体非法 → null；单条非法 → 整单拒绝）。 */
export function parseResearchCandidates(output: string | null | undefined): readonly ResearchCandidate[] | null {
  const block = extractLastJsonBlock(output);
  if (block === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidates = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return null;
  const result: ResearchCandidate[] = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const key = requiredString(item, 'key');
    const claimKey = requiredString(item, 'claimKey');
    const url = requiredString(item, 'url');
    if (!key || !claimKey || !url) return null;
    result.push({
      key,
      claimKey,
      url,
      title: optionalString(item, 'title'),
      author: optionalString(item, 'author'),
      summary: optionalString(item, 'summary'),
      publishedAt: optionalString(item, 'publishedAt'),
      excerpt: optionalString(item, 'excerpt'),
      sourceKind: item.sourceKind === 'official' ? 'official' : 'secondary',
      inlineText: optionalString(item, 'inlineText')
    });
  }
  return result;
}

/** 结构化输出 → claim 建议（fail-closed：整体非法 → null）。 */
export function parseClaimProposals(output: string | null | undefined): readonly ResearchClaimProposal[] | null {
  const block = extractLastJsonBlock(output);
  if (block === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const claims = (parsed as Record<string, unknown>).claims;
  if (!Array.isArray(claims)) return null;
  const result: ResearchClaimProposal[] = [];
  const statuses: readonly ResearchClaimStatus[] = ['supported', 'contradicted', 'unresolved', 'source_unavailable'];
  for (const entry of claims) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const claimKey = requiredString(item, 'claimKey');
    if (!claimKey) return null;
    const status = item.status;
    if (typeof status !== 'string' || !statuses.includes(status as ResearchClaimStatus)) return null;
    const rawIds = item.evidenceSourceIds;
    if (rawIds !== undefined && rawIds !== null && !Array.isArray(rawIds)) return null;
    const evidenceSourceIds: string[] = [];
    for (const sourceId of Array.isArray(rawIds) ? rawIds : []) {
      if (typeof sourceId !== 'string' || !sourceId.trim()) return null;
      const trimmed = sourceId.trim();
      if (!evidenceSourceIds.includes(trimmed)) evidenceSourceIds.push(trimmed);
    }
    result.push({ claimKey, status: status as ResearchClaimStatus, evidenceSourceIds, verdictReason: optionalString(item, 'verdictReason') });
  }
  return result;
}

/**
 * 执行一轮研究（fresh 或从 checkpoint 续跑）。
 * 返回 terminal + EvidencePack + 最终 progress/checkpoint；不写任务终态（由接线方落盘）。
 */
export async function runResearchJob(input: ResearchJobRunInput, deps: ResearchRunnerDeps): Promise<ResearchJobRunResult> {
  const { task, gap, signal } = input;
  const budget = resolveResearchBudget(gap.budget);
  const checkpoint = parseResearchCheckpoint(task.checkpoint);
  const persistedProgress = parseResearchProgress(task.progress);
  const startedAtIso = checkpoint?.startedAt ?? deps.now().toISOString();
  const startedAtMs = Date.parse(startedAtIso);
  const round = checkpoint?.round ?? 1;
  const initialBudgetLeftMs = checkpoint?.budgetLeftMs ?? budget.timeMinutes * 60_000;
  const processed0 = checkpoint?.candidatesProcessed ?? 0;
  const sourceWriteReceipts = await deps.listSourceWriteReceipts?.() ?? [];
  const receiptSourceIds = [...new Set(sourceWriteReceipts.map((receipt) => receipt.sourceId))];
  const verified0 = sourceWriteReceipts.length > 0 ? receiptSourceIds.length : persistedProgress?.verified ?? 0;
  const saved0 = sourceWriteReceipts.length > 0 ? new Set(sourceWriteReceipts.filter((receipt) => receipt.created).map((receipt) => receipt.sourceId)).size : persistedProgress?.saved ?? 0;
  const claimStatuses: Record<string, ResearchClaimStatus> = { ...(checkpoint?.claimsSnapshot ?? {}) };
  const requiredClaims = gap.requiredClaims;

  const remainingMs = (): number => {
    const elapsed = Number.isFinite(startedAtMs) ? Math.max(0, deps.now().getTime() - startedAtMs) : Number.POSITIVE_INFINITY;
    const raw = initialBudgetLeftMs - elapsed;
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  };
  const buildCheckpoint = (processed: number, snapshot: Record<string, ResearchClaimStatus>): ResearchCheckpoint =>
    buildResearchCheckpoint({ round, startedAt: startedAtIso, budgetLeftMs: remainingMs(), candidatesProcessed: processed, claimsSnapshot: { ...snapshot } });
  /** 需继续处理的 claim：尚未判定，或判定为 unresolved/source_unavailable（恢复续跑可再尝试——仍属第 1 轮，不开始第 2 轮）。 */
  const claimNeedsWork = (key: string): boolean => claimStatuses[key] !== 'supported' && claimStatuses[key] !== 'contradicted';
  /** 全部 required claim 已正面解决（supported/contradicted）→ succeeded。 */
  const allAnswered = (): boolean => requiredClaims.every((claim) => claimStatuses[claim.key] === 'supported' || claimStatuses[claim.key] === 'contradicted');
  /** EvidencePack.unresolvedRequiredClaims：未正面解决的 claim 键（pending/unresolved/source_unavailable 均属未答）。 */
  const unansweredKeys = (): string[] => requiredClaims.filter((claim) => claimNeedsWork(claim.key)).map((claim) => claim.key);
  const aborted = (): ResearchJobRunResult => ({
    terminal: 'cancelled',
    pack: null,
    progress: { planned: budget.maxCandidates, processed, verified, saved },
    checkpoint: buildCheckpoint(processed, claimStatuses),
    claimStatuses: { ...claimStatuses }
  });
  const assemble = async (terminalReason: ResearchEvidencePackTerminalReason, terminal: 'succeeded' | 'partial', processed: number): Promise<ResearchJobRunResult> => {
    const claims = await deps.listClaims();
    // 证据 sourceIds = 本轮新入库 ∪ 既有 claim 行引用的证据（恢复续跑不丢已入库证据）。
    const claimSourceIds = claims.flatMap((claim) => [...claim.evidenceSourceIds]);
    const allSourceIds = [...new Set([...sourceIds, ...claimSourceIds])];
    const pack = buildResearchEvidencePack({
      jobId: task.id,
      round,
      claims: claims.map((claim) => ({
        id: claim.id,
        key: claim.claimKey,
        status: claim.status,
        verdictReason: claim.verdictReason,
        evidenceSourceIds: claim.evidenceSourceIds,
        needsTimeExcerpt: claim.needsTimeExcerpt
      })),
      sourceIds: allSourceIds,
      validSourceCount: verified,
      candidateCount: processed,
      timeSpentMinutes: Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((deps.now().getTime() - startedAtMs) / 60_000)) : 0,
      terminalReason,
      unresolvedRequiredClaims: unansweredKeys()
    });
    return { terminal, pack, progress: { planned: budget.maxCandidates, processed, verified, saved }, checkpoint: buildCheckpoint(processed, claimStatuses), claimStatuses: { ...claimStatuses } };
  };

  let processed = processed0;
  let verified = verified0;
  let saved = saved0;
  let sourceIds: string[] = receiptSourceIds;
  const evidenceByClaim: Record<string, ResearchEvidenceItem[]> = {};
  const failuresByClaim: Record<string, { total: number; failed: number; reason: string | null }> = {};

  try {
    // 硬上限：仅一轮（恢复点已耗尽轮次 → 不再开始第 2 轮）。
    if (round > budget.maxRounds) {
      if (allAnswered()) return assemble('claims_resolved', 'succeeded', processed);
      return assemble('budget_exhausted', 'partial', processed);
    }
    // 恢复点已全部解决：直接 succeeded（不再发现/抓取）。
    if (allAnswered()) return assemble('claims_resolved', 'succeeded', processed);
    if (signal.aborted) return aborted();
    if (remainingMs() <= 0) {
      const judged = requiredClaims.some((claim) => isTerminalResearchStatus(claimStatuses[claim.key]));
      if (judged) return assemble('budget_exhausted', 'partial', processed);
      return { terminal: 'failed', failure: { code: 'RESEARCH_NO_CLAIMS_JUDGED', message: '剩余预算耗尽前未产出任何判定。' }, pack: null, progress: { planned: budget.maxCandidates, processed, verified, saved }, checkpoint: buildCheckpoint(processed, claimStatuses), claimStatuses: { ...claimStatuses } };
    }

    sourceIds = [...new Set([...sourceIds, ...(await deps.listClaims()).flatMap((claim) => claim.evidenceSourceIds)])];
    // 发现候选（机器上限 40；跳过已终态 claim 的候选；恢复续跑只消费剩余候选头寸）。
    const discovered = await deps.discoverCandidates(gap, { maxCandidates: budget.maxCandidates, timeLeftMs: remainingMs() });
    if (signal.aborted) return aborted();
    const accepted = (discovered ?? []).slice(0, budget.maxCandidates);
    const pendingCandidates = accepted.filter((candidate) => claimNeedsWork(candidate.claimKey));
    const headroom = Math.max(0, budget.maxCandidates - processed);
    const todo = pendingCandidates.slice(0, headroom);
    for (const claim of requiredClaims) {
      if (claimNeedsWork(claim.key)) failuresByClaim[claim.key] = { total: 0, failed: 0, reason: null };
    }

    // 抓取 + 写回（任务内并发信号量 = maxParallelFetches；每批前检查时间门）。
    let budgetExhausted = false;
    for (let index = 0; index < todo.length; ) {
      if (signal.aborted) return aborted();
      if (remainingMs() <= 0) { budgetExhausted = true; break; }
      const batch = todo.slice(index, index + budget.maxParallelFetches);
      index += batch.length;
      const results = await Promise.all(batch.map(async (candidate) => ({
        candidate,
        fetched: await deps.fetchCandidate(candidate, { deadlineMs: Math.max(1, remainingMs()) })
      })));
      for (const { candidate, fetched } of results) {
        processed += 1;
        const failure = failuresByClaim[candidate.claimKey];
        if (!failure) continue;
        failure.total += 1;
        let becameEvidence = false;
        if (fetched.ok) {
          const title = (fetched.title ?? candidate.title ?? '').trim();
          const author = (candidate.author ?? '').trim();
          const summary = (candidate.summary ?? snippetOf(fetched.text)).trim();
          if (title && author && summary) {
            const publishedAt = candidate.publishedAt ?? fetched.publishedAt ?? null;
            const written = await deps.writeSource({
              claimKey: candidate.claimKey,
              candidateKey: candidate.key,
              url: candidate.url,
              title,
              author,
              summary,
              publishedAt,
              excerpt: candidate.excerpt ?? null,
              sourceKind: candidate.sourceKind,
              requestId: agentRequestId(task.id, `source:${researchSourceKeyFor(candidate.url)}`)
            });
            if (written) {
              // 写回幂等：同 canonical URL → 同 requestId（后端按回执重放同一 sourceId）；sourceIds 含恢复种子 → 重放不虚增 verified/saved。
              const items = evidenceByClaim[candidate.claimKey] ?? [];
              if (!items.some((item) => item.sourceId === written.sourceId)) {
                evidenceByClaim[candidate.claimKey] = [...items, {
                  sourceId: written.sourceId,
                  claimKey: candidate.claimKey,
                  url: candidate.url,
                  title,
                  author,
                  summary,
                  publishedAt,
                  collectedAt: null,
                  excerpt: candidate.excerpt ?? null,
                  sourceKind: candidate.sourceKind
                }];
              }
              if (!sourceIds.includes(written.sourceId)) {
                sourceIds.push(written.sourceId);
                verified += 1;
                if (written.created) saved += 1;
              }
              becameEvidence = true;
            } else {
              failure.reason ??= 'write_rejected';
            }
          } else {
            failure.reason ??= 'missing_fields';
          }
        } else {
          failure.reason ??= fetched.reason;
        }
        if (!becameEvidence) failure.failed += 1;
      }
      await deps.persistProgress({
        planned: budget.maxCandidates,
        processed,
        verified,
        saved,
        checkpoint: buildCheckpoint(processed, claimStatuses),
        message: `研究进行中：已处理 ${processed}/${budget.maxCandidates} 候选，${verified} 条有效来源。`
      });
    }
    if (signal.aborted) return aborted();

    // claim 判定（系统机器校验；剩余预算内执行建议阶段）。
    const pendingClaims = requiredClaims.filter((claim) => claimNeedsWork(claim.key));
    if (pendingClaims.length > 0 && remainingMs() > 0) {
      const proposals = await deps.proposeClaims({ claims: requiredClaims, evidenceByClaim, timeLeftMs: remainingMs() });
      if (signal.aborted) return aborted();
      const proposalsByKey = new Map<string, ResearchClaimProposal>((proposals ?? []).map((proposal) => [proposal.claimKey, proposal]));
      const verifiedAt = deps.now().toISOString();
      const claimsToPersist: Array<{
        claimKey: string; claimText: string; claimType: ResearchRequiredClaim['type']; status: ResearchClaimStatus;
        verdictReason: string; evidenceSourceIds: readonly string[]; verifiedAt: string;
      }> = [];
      for (const claim of pendingClaims) {
        const evidence = evidenceByClaim[claim.key] ?? [];
        const failure = failuresByClaim[claim.key] ?? { total: 0, failed: 0, reason: null };
        const proposal = proposalsByKey.get(claim.key) ?? null;
        const verdict = validateClaimProposal({
          claimKey: claim.key,
          claimType: claim.type,
          evidence: new Map(evidence.map((item) => [item.sourceId, item])),
          candidateTotal: failure.total,
          candidateFailed: failure.failed,
          failureReason: failure.reason
        }, proposal);
        claimStatuses[claim.key] = verdict.status;
        const validIds = (proposal?.evidenceSourceIds ?? []).filter((sourceId) => evidence.some((item) => item.sourceId === sourceId));
        claimsToPersist.push({
          claimKey: claim.key,
          claimText: claim.text,
          claimType: claim.type,
          status: verdict.status,
          verdictReason: verdict.verdictReason,
          evidenceSourceIds: validIds,
          verifiedAt
        });
      }
      if (claimsToPersist.length > 0) await deps.persistClaims(claimsToPersist);
      await deps.persistProgress({
        planned: budget.maxCandidates,
        processed,
        verified,
        saved,
        checkpoint: buildCheckpoint(processed, claimStatuses),
        message: `研究完成：${verified} 条有效来源，${claimsToPersist.length} 个声明已判定。`
      });
    }
    if (signal.aborted) return aborted();

    const judged = requiredClaims.some((claim) => isTerminalResearchStatus(claimStatuses[claim.key]));
    if (!judged) {
      return { terminal: 'failed', failure: { code: 'RESEARCH_NO_CLAIMS_JUDGED', message: '本轮未产出任何判定。' }, pack: null, progress: { planned: budget.maxCandidates, processed, verified, saved }, checkpoint: buildCheckpoint(processed, claimStatuses), claimStatuses: { ...claimStatuses } };
    }
    const resolved = allAnswered();
    const terminalReason: ResearchEvidencePackTerminalReason = resolved ? 'claims_resolved' : (budgetExhausted ? 'budget_exhausted' : 'candidates_exhausted');
    return assemble(terminalReason, resolved ? 'succeeded' : 'partial', processed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      terminal: 'failed',
      failure: { code: 'RESEARCH_FAILED', message },
      pack: null,
      progress: { planned: budget.maxCandidates, processed, verified, saved },
      checkpoint: buildCheckpoint(processed, claimStatuses),
      claimStatuses: { ...claimStatuses }
    };
  }
}
