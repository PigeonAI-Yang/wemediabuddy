/**
 * WMB-5173 / CAP-028 §8.1 ②/§8.2：evidenceGap 自动派记者（桌助协调入口的派单机器）。
 *
 * - 同父唯一：同一 parentJobId 至多一个活动 research 任务（幂等返回既有，不重复派单）。
 * - 边界继承：businessDate + projectId 从父任务工单合同（context_refs）派生，不接收外部覆盖。
 * - 三层止环（任何一层都断链）：
 *   1. 派生层：父角色 ∈ {writer, planner, librarian}（intent 映射）；research/reporter 父 → VALIDATION_ERROR。
 *   2. 唯一性层：research_successor 由 jobs.dedupe_key UNIQUE 保证（本模块不重造）。
 *   3. 行为层：父工单本身是 research_successor 产物 → 拒绝自动再派研究（续派后缺料 needs_user 交人，
 *      再开研究必须主编显式决策）。
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JobSpawner } from './job-spawner.ts';
import { getAgentTask } from './agent-tasks.ts';
import { readJobContractFromRefs } from './job-object-boundary.ts';
import { readResearchGap } from './research-task-state.ts';
import { isResearchSuccessorRow } from './research-successor.ts';
import { RESEARCH_DEFAULT_BUDGET, resolveResearchBudget } from './research-job-runner.ts';
import type { ResearchBudget, ResearchClaimType, ResearchGap, ResearchRequiredClaim, RoleJobRequest } from './role-job-registry.ts';
import { JOB_ERROR_CODES } from './role-job-registry.ts';

export type EvidenceGapRequiredClaimInput = Readonly<{
  key: string;
  text: string;
  type: ResearchClaimType;
}>;

export type EvidenceGapDispatchInput = {
  parentTaskId: string;
  requiredClaims: readonly EvidenceGapRequiredClaimInput[];
  /** 深度档硬默认缺省；逐键回落 + 机器硬上限（resolveResearchBudget：上调钳制到 RESEARCH_DEFAULT_BUDGET，合法下调保留）。 */
  budget?: Partial<ResearchBudget> | null;
  /** 首批只读面固定枚举；缺省 web/x/xhs。 */
  channels?: readonly ('web' | 'x' | 'xhs')[] | null;
  brief?: string | null;
  gapId?: string | null;
};

export type ResearchDispatchResult =
  | Readonly<{ ok: true; reused: false; spawnedJobId: string; researchTaskId: null }>
  | Readonly<{ ok: true; reused: true; existingTaskId: string; existingJobId: string | null }>;

const RESEARCH_PARENT_INTENT_TO_ROLE: Readonly<Record<string, 'writer' | 'planner' | 'librarian'>> = Object.freeze({
  studio_draft: 'writer',
  daily_judge: 'planner',
  page_library: 'librarian'
});

/**
 * 父任务 intent → 父角色（派生层白名单）。research/daily_scan/daily_intelligence/其他 page_* → null（不可作父）。
 */
export function deriveResearchParentRole(intent: string): 'writer' | 'planner' | 'librarian' | null {
  return RESEARCH_PARENT_INTENT_TO_ROLE[intent] ?? null;
}

/** 同父唯一：活动（未终态）research 任务中是否存在同一 parentJobId 的缺口。 */
export function findActiveResearchForParent(database: DatabaseSync, parentJobId: string): { taskId: string; jobId: string | null } | null {
  const rows = database.prepare(
    `SELECT id FROM agent_tasks WHERE intent = 'research' AND status IN ('running', 'needs_user', 'interrupted') ORDER BY updated_at`
  ).all() as Array<{ id: string }>;
  for (const row of rows) {
    const task = getAgentTask(database, row.id);
    if (!task) continue;
    const gap = readResearchGap(task.contextRefs);
    if (gap && gap.parentJobId === parentJobId) {
      const jobId = typeof task.contextRefs.jobId === 'string' && task.contextRefs.jobId ? task.contextRefs.jobId : null;
      return { taskId: task.id, jobId };
    }
  }
  return null;
}

function validationError(message: string): Error {
  return Object.assign(new Error(message), { code: JOB_ERROR_CODES.VALIDATION_ERROR });
}

function assertClaimsValid(claims: readonly EvidenceGapRequiredClaimInput[]): void {
  if (!Array.isArray(claims) || claims.length === 0) {
    throw validationError('requiredClaims 必须是非空数组。');
  }
  const seen = new Set<string>();
  for (const [index, claim] of claims.entries()) {
    if (!claim || typeof claim !== 'object') throw validationError(`requiredClaims[${index}] 必须是对象。`);
    const key = typeof claim.key === 'string' ? claim.key.trim() : '';
    const text = typeof claim.text === 'string' ? claim.text.trim() : '';
    if (!key || !text) throw validationError(`requiredClaims[${index}] 需要非空 key 与 text。`);
    if (claim.type !== 'fact' && claim.type !== 'price' && claim.type !== 'policy') {
      throw validationError(`requiredClaims[${index}].type 只允许 fact/price/policy。`);
    }
    if (seen.has(key)) throw validationError(`requiredClaims key 重复：${key}。`);
    seen.add(key);
  }
}

function normalizeChannels(channels: readonly ('web' | 'x' | 'xhs')[] | null | undefined): readonly ('web' | 'x' | 'xhs')[] {
  if (channels === undefined || channels === null || channels.length === 0) return Object.freeze(['web', 'x', 'xhs']);
  const seen = new Set<'web' | 'x' | 'xhs'>();
  for (const channel of channels) {
    if (channel !== 'web' && channel !== 'x' && channel !== 'xhs') throw validationError(`channels 只允许 web/x/xhs。`);
    seen.add(channel);
  }
  return Object.freeze([...seen]);
}

function buildResearchBrief(parentJobId: string, parentRoleId: string, claims: readonly EvidenceGapRequiredClaimInput[], customBrief: string | null): string {
  const claimLines = claims.map((claim) => `- ${claim.key}（${claim.type}）：${claim.text}`).join('\n');
  return [
    '研究补料工单（evidenceGap 自动派记者）：',
    `父工单 ${parentRoleId} / ${parentJobId} 在证据上存在缺口，需要核查以下声明：`,
    claimLines,
    '研究纪律：只经白名单只读工具（web/x/xhs）；预算机器硬执行（深度档）；不得编造无出处数字或来源 URL。',
    ...(customBrief ? [`补充指令：${customBrief}`] : [])
  ].join('\n');
}

/**
 * evidenceGap 自动派记者：
 * 1. 父任务必须存在且持有工单合同（context_refs.jobId）——缺失 fail-closed（无法建立 dedupe 链）。
 * 2. 边界继承：businessDate = 父任务业务日；projectId = 父工单合同边界 projectId。
 * 3. 三层止环 + 同父唯一（幂等返回既有活动 research 任务）。
 * 4. budget 逐键回落 + 机器硬上限（RESEARCH_DEFAULT_BUDGET；调用方上调一律钳制，合法下调保留）。
 * 5. spawner.spawn 派生 research intent 工单（角色注册表唯一真相源）。
 */
export function dispatchResearchForEvidenceGap(input: {
  spawner: JobSpawner;
  database: DatabaseSync;
  parentTaskId: string;
  requiredClaims: readonly EvidenceGapRequiredClaimInput[];
  budget?: Partial<ResearchBudget> | null;
  channels?: readonly ('web' | 'x' | 'xhs')[] | null;
  brief?: string | null;
  gapId?: string | null;
}): ResearchDispatchResult {
  const parentTask = getAgentTask(input.database, input.parentTaskId);
  if (!parentTask) {
    throw validationError(`父任务不存在：${input.parentTaskId}。`);
  }
  const contract = readJobContractFromRefs(parentTask.contextRefs);
  if (!contract || !contract.jobId) {
    throw validationError('父任务缺少工单合同 jobId（无法建立研究续派 dedupe 链），拒绝派单。');
  }
  const parentJobId = contract.jobId;
  const parentRoleId = deriveResearchParentRole(parentTask.intent);
  if (!parentRoleId) {
    // 派生层：research/reporter（daily_scan/daily_intelligence）与其他意图不可作研究父。
    throw validationError(`父任务 intent=${parentTask.intent} 不可作研究父（只允许 writer/planner/librarian；research→research 禁止）。`);
  }
  if (isResearchSuccessorRow(input.database, parentJobId)) {
    // 行为层：父工单是研究续派产物——续派后缺料不自动再派研究（needs_user 交人决策）。
    throw validationError('父工单是研究续派产物：续派后再次缺料不自动再派研究（needs_user 交人决策；再开研究须主编显式决策）。');
  }
  assertClaimsValid(input.requiredClaims);

  const existing = findActiveResearchForParent(input.database, parentJobId);
  if (existing) {
    return { ok: true, reused: true, existingTaskId: existing.taskId, existingJobId: existing.jobId };
  }

  const budget = resolveResearchBudget({ ...RESEARCH_DEFAULT_BUDGET, ...(input.budget ?? {}) } as ResearchBudget);
  const channels = normalizeChannels(input.channels);
  const claims: readonly ResearchRequiredClaim[] = Object.freeze(
    input.requiredClaims.map((claim) => Object.freeze({ key: claim.key.trim(), text: claim.text.trim(), type: claim.type }))
  );
  const gap: ResearchGap = Object.freeze({
    gapId: input.gapId?.trim() || `research-${randomUUID()}`,
    parentJobId,
    parentTaskId: parentTask.id,
    parentRoleId,
    requiredClaims: claims,
    budget,
    channels
  });
  const request: RoleJobRequest = Object.freeze({
    roleId: 'reporter',
    brief: buildResearchBrief(parentJobId, parentRoleId, claims, input.brief?.trim() || null),
    businessDate: parentTask.businessDate,
    projectId: contract.boundary.projectId,
    research: gap
  });
  const job = input.spawner.spawn(request);
  return { ok: true, reused: false, spawnedJobId: job.id, researchTaskId: null };
}
