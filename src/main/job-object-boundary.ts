import type { DatabaseSync } from 'node:sqlite';
import { CommandDispatchError } from './command-dispatcher.ts';
import type { EmployeeRole } from './job-pool.ts';
import type { ResearchBudget, ResearchGap, ResearchRequiredClaim, RoleJobRequest } from './role-job-registry.ts';

/**
 * WMB-5141 工单对象边界（设计 §8.1：锁键是什么，写权对象就是什么）。
 * businessDate/projectId/sourceIds/scope 四维；scope='workspace' 时 sourceIds 不受约束。
 */
export type JobObjectBoundary = Readonly<{
  businessDate: string | null;
  projectId: string | null;
  sourceIds: readonly string[];
  /** 渠道 feed 键（reporter）：sources.upsert_batch items[].feedId 的对象面。 */
  feedIds: readonly string[];
  scope: 'workspace' | null;
}>;

/**
 * WMB-5141 持久续派合同（设计 §7.3/§12.2.1）：从 agent_tasks.context_refs_json 读回。
 * jobId 存在 = 该任务携带 spawn 合同，dispatcher 必须对其执行对象级硬隔离。
 */
export type JobContract = Readonly<{
  jobId: string;
  roleId: string;
  brief: string;
  boundary: JobObjectBoundary;
}>;

export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return value === 'reporter' || value === 'planner' || value === 'writer' || value === 'librarian';
}

/** 标准化 sourceIds：trim、去重、字典序（WMB-5141 合同 §Scope.1）。 */
export function normalizeSourceIds(ids: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const value = id.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  result.sort();
  return Object.freeze(result);
}

const EMPTY_SOURCE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_BOUNDARY: JobObjectBoundary = Object.freeze({ businessDate: null, projectId: null, sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null });

/**
 * 从 spawn 请求派生工单对象边界。
 * reporter 边界 = businessDate + channelIds + sourceFeedIds（锁键 scan:<ws>:<date>:<channel> 的对象面，
 * upsert_batch 以 feedId 写渠道对象）；planner = businessDate；writer = projectId；
 * librarian = sourceIds/scope（无 sourceIds 且未显式限定 scope → 整个工作空间资料库）。
 */
export function buildJobObjectBoundary(request: RoleJobRequest, businessDate?: string | null): JobObjectBoundary {
  const date = businessDate ?? null;
  if (request.roleId === 'reporter') {
    // WMB-5170 research 变体：boundary 携带 projectId（context_refs 持久化与 research 工单重建需要）；
    // 普通 reporter 老路径 projectId 恒 null。
    return Object.freeze({
      businessDate: date,
      projectId: 'research' in request ? (request.projectId ?? null) : null,
      sourceIds: normalizeSourceIds(request.channelIds ?? []),
      feedIds: normalizeSourceIds(request.sourceFeedIds ?? []),
      scope: null
    });
  }
  if (request.roleId === 'planner') {
    return Object.freeze({ businessDate: date, projectId: null, sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null });
  }
  if (request.roleId === 'writer') {
    return Object.freeze({ businessDate: date, projectId: request.projectId ?? null, sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null });
  }
  const sourceIds = normalizeSourceIds(request.sourceIds ?? []);
  return Object.freeze({
    businessDate: date,
    projectId: null,
    sourceIds,
    feedIds: EMPTY_SOURCE_IDS,
    scope: request.scope === 'workspace' ? 'workspace' : sourceIds.length ? null : 'workspace'
  });
}

/**
 * 持久续派合同 refs：jobId/roleId/brief + 边界参数（businessDate/projectId/sourceIds/scope）。
 * reporter 的 sourceFeedIds 单独保留（重建原 RoleJobRequest 需要）。
 */
export function buildJobContextRefs(input: { jobId: string; request: RoleJobRequest; boundary: JobObjectBoundary }): Record<string, unknown> {
  const refs: Record<string, unknown> = {
    jobId: input.jobId,
    roleId: input.request.roleId,
    brief: input.request.brief
  };
  if (input.boundary.businessDate) refs.businessDate = input.boundary.businessDate;
  if (input.boundary.projectId) refs.projectId = input.boundary.projectId;
  if (input.boundary.sourceIds.length) refs.sourceIds = [...input.boundary.sourceIds];
  if (input.boundary.feedIds.length) refs.sourceFeedIds = [...input.boundary.feedIds];
  if (input.boundary.scope) refs.scope = input.boundary.scope;
  if (input.request.roleId === 'writer') refs.writerTask = input.request.writerTask;
  // WMB-5170 research 变体：完整持久化已校验 research 块（重建精确 research 工单需要；
  // 深拷贝为普通对象，JSON 序列化后无共享冻结引用）。
  if ('research' in input.request) {
    const gap = input.request.research;
    refs.research = {
      gapId: gap.gapId,
      parentJobId: gap.parentJobId,
      parentTaskId: gap.parentTaskId,
      parentRoleId: gap.parentRoleId,
      requiredClaims: gap.requiredClaims.map((claim) => ({ key: claim.key, text: claim.text, type: claim.type })),
      budget: { ...gap.budget },
      channels: [...gap.channels]
    };
  }
  return refs;
}

/** 从 context_refs 读回持久续派合同（无 jobId = 无 spawn 合同，返回 null）。 */
export function readJobContractFromRefs(refs: Record<string, unknown>): JobContract | null {
  const jobId = refs.jobId;
  if (typeof jobId !== 'string' || !jobId.trim()) return null;
  return Object.freeze({
    jobId,
    roleId: typeof refs.roleId === 'string' ? refs.roleId : '',
    brief: typeof refs.brief === 'string' ? refs.brief : '',
    boundary: Object.freeze({
      businessDate: typeof refs.businessDate === 'string' && refs.businessDate ? refs.businessDate : null,
      projectId: typeof refs.projectId === 'string' && refs.projectId ? refs.projectId : null,
      sourceIds: normalizeSourceIds(Array.isArray(refs.sourceIds) ? refs.sourceIds : []),
      feedIds: normalizeSourceIds(Array.isArray(refs.sourceFeedIds) ? refs.sourceFeedIds : []),
      scope: refs.scope === 'workspace' ? 'workspace' : null
    })
  });
}

/** 按 taskId 读持久续派合同（agent_tasks.context_refs_json 单列读）。 */
export function readJobContract(database: DatabaseSync, taskId: string): JobContract | null {
  const row = database.prepare('SELECT context_refs_json AS refsJson FROM agent_tasks WHERE id=?').get(taskId) as { refsJson?: string } | undefined;
  if (!row || typeof row.refsJson !== 'string') return null;
  return readJobContractFromRefs(JSON.parse(row.refsJson) as Record<string, unknown>);
}

/**
 * 从 context_refs 重建已校验 ResearchGap（字段缺失/非法 → null，续派方须重新提供输入；
 * 与 parseResearchGap 同语义的 fail-closed 值对象重建）。
 */
function researchGapFromRefs(value: unknown): ResearchGap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const gapId = stringField(record, 'gapId');
  const parentJobId = stringField(record, 'parentJobId');
  const parentTaskId = stringField(record, 'parentTaskId');
  const parentRoleId = record.parentRoleId;
  if (!gapId || !parentJobId || !parentTaskId) return null;
  if (parentRoleId !== 'writer' && parentRoleId !== 'planner' && parentRoleId !== 'librarian' && parentRoleId !== 'desk') return null;
  if (!Array.isArray(record.requiredClaims) || record.requiredClaims.length === 0) return null;
  const requiredClaims: ResearchRequiredClaim[] = [];
  for (const item of record.requiredClaims) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const claim = item as Record<string, unknown>;
    const key = stringField(claim, 'key');
    const text = stringField(claim, 'text');
    if (!key || !text || (claim.type !== 'fact' && claim.type !== 'price' && claim.type !== 'policy')) return null;
    requiredClaims.push(Object.freeze({ key, text, type: claim.type }));
  }
  const budget = record.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null;
  const budgetRecord = budget as Record<string, unknown>;
  const budgetValues: Record<'timeMinutes' | 'minValidSources' | 'maxCandidates' | 'maxParallelFetches' | 'maxRounds', number> = {
    timeMinutes: 0,
    minValidSources: 0,
    maxCandidates: 0,
    maxParallelFetches: 0,
    maxRounds: 0
  };
  for (const key of ['timeMinutes', 'minValidSources', 'maxCandidates', 'maxParallelFetches', 'maxRounds'] as const) {
    const n = budgetRecord[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
    budgetValues[key] = n;
  }
  if (!Array.isArray(record.channels) || record.channels.length === 0) return null;
  const channels: Array<'web' | 'x' | 'xhs'> = [];
  for (const channel of record.channels) {
    if (channel !== 'web' && channel !== 'x' && channel !== 'xhs') return null;
    channels.push(channel);
  }
  return Object.freeze({
    gapId,
    parentJobId,
    parentTaskId,
    parentRoleId,
    requiredClaims: Object.freeze(requiredClaims),
    budget: Object.freeze(budgetValues),
    channels: Object.freeze(channels)
  });
}

/**
 * 一键续派：从 context_refs_json 重建原 RoleJobRequest（jobId/roleId/brief/边界参数）。
 * 字段缺失（如 writer 无 projectId）返回 null——续派方须重新提供输入。
 */
export function rebuildRoleJobRequest(refs: Record<string, unknown>): RoleJobRequest | null {
  const contract = readJobContractFromRefs(refs);
  if (!contract || !isEmployeeRole(contract.roleId) || !contract.brief) return null;
  const brief = contract.brief;
  const businessDate = contract.boundary.businessDate;
  if (contract.roleId === 'writer') {
    if (!contract.boundary.projectId) return null;
    const writerTask = refs.writerTask ?? 'core_draft';
    if (writerTask !== 'core_draft' && writerTask !== 'xiaohongshu_platform_version') return null;
    return Object.freeze({ roleId: 'writer', brief, projectId: contract.boundary.projectId, writerTask, businessDate });
  }
  if (contract.roleId === 'reporter') {
    // WMB-5170 research 变体：refs.research 存在 → 重建精确 research 工单（含 projectId）；
    // 损坏 research refs fail closed（null），绝不静默降级为普通 reporter；无 research 键走老路径。
    const hasResearchRef = 'research' in refs;
    if (hasResearchRef) {
      const research = researchGapFromRefs(refs.research);
      if (!research) return null;
      return Object.freeze({
        roleId: 'reporter',
        brief,
        businessDate,
        projectId: contract.boundary.projectId,
        research
      });
    }
    const sourceFeedIds = Array.isArray(refs.sourceFeedIds)
      ? refs.sourceFeedIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : [];
    return Object.freeze({
      roleId: 'reporter',
      brief,
      businessDate,
      channelIds: contract.boundary.sourceIds.length ? [...contract.boundary.sourceIds] : null,
      sourceFeedIds: sourceFeedIds.length ? [...sourceFeedIds] : null
    });
  }
  if (contract.roleId === 'librarian') {
    return Object.freeze({
      roleId: 'librarian',
      brief,
      sourceIds: contract.boundary.sourceIds.length ? [...contract.boundary.sourceIds] : null,
      scope: contract.boundary.scope
    });
  }
  return Object.freeze({ roleId: 'planner', brief, businessDate });
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceIdsFromRows(rows: unknown, key: string): readonly string[] {
  if (!Array.isArray(rows)) return EMPTY_SOURCE_IDS;
  return normalizeSourceIds(rows.map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : null)));
}

/** 命令 → 对象边界提取器（§12.2.7）：只登记可兑现边界语义的命令，其余不约束。 */
const COMMAND_BOUNDARY_EXTRACTORS: Readonly<Record<string, (input: Record<string, unknown>) => JobObjectBoundary>> = Object.freeze({
  'plans.save': (input) => Object.freeze({ businessDate: stringField(input, 'planDate'), projectId: null, sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null }),
  'content.save_version': (input) => Object.freeze({ businessDate: null, projectId: stringField(input, 'projectId'), sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null }),
  // content.create 真实输入 shape：{ planItemId?, sourceIds?: string[] }（纯字符串数组，非行对象）。
  'content.create': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: normalizeSourceIds(Array.isArray(input.sourceIds) ? input.sourceIds : []), feedIds: EMPTY_SOURCE_IDS, scope: null }),
  'knowledge.record_batch': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceIdsFromRows(input.items, 'sourceId'), feedIds: EMPTY_SOURCE_IDS, scope: null }),
  'sources.upsert_batch': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: EMPTY_SOURCE_IDS, feedIds: sourceIdsFromRows(input.items, 'feedId'), scope: null }),
  'sources.lane_gate': (input) => Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceIdsFromRows(input.judgments, 'sourceId'), feedIds: EMPTY_SOURCE_IDS, scope: null }),
  'sources.lane_restore': (input) => {
    const sourceId = stringField(input, 'sourceId');
    return Object.freeze({ businessDate: null, projectId: null, sourceIds: sourceId ? normalizeSourceIds([sourceId]) : EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null });
  },
  'sources.update_status': (input) => {
    const id = stringField(input, 'id');
    return Object.freeze({ businessDate: null, projectId: null, sourceIds: id ? normalizeSourceIds([id]) : EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null });
  },
  'knowledge.topic_maintenance_propose': (input) => {
    const changes = Array.isArray(input.changes) ? input.changes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
    const sourceIds = normalizeSourceIds(changes.filter((item) => item.kind === 'reassign').map((item) => item.sourceId));
    return Object.freeze({ businessDate: null, projectId: null, sourceIds, feedIds: EMPTY_SOURCE_IDS, scope: changes.some((item) => item.kind !== 'reassign') ? 'workspace' : null });
  },
  // WMB-5290：项目专项调查主管工具按 projectId 约束对象边界。
  'investigation.outline_save': (input) => Object.freeze({ businessDate: null, projectId: stringField(input, 'projectId'), sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null }),
  'investigation.review_research': (input) => Object.freeze({ businessDate: null, projectId: stringField(input, 'projectId'), sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null }),
  'investigation.direction_save': (input) => Object.freeze({ businessDate: null, projectId: stringField(input, 'projectId'), sourceIds: EMPTY_SOURCE_IDS, feedIds: EMPTY_SOURCE_IDS, scope: null })
});

/** 解析命令输入携带的对象边界（未登记的命令 → 空边界，不约束）。 */
export function resolveCommandObjectBoundary(command: string, input: unknown): JobObjectBoundary {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const extract = COMMAND_BOUNDARY_EXTRACTORS[command];
  return extract ? extract(record) : EMPTY_BOUNDARY;
}

/**
 * 从相关上下文（grant issue 的 relevantContext）读取对象边界主张。
 * 显式 jobBoundary 对象（自动授权 = 任务自身边界）优先；否则回落顶层业务键
 * （手动授权声明的 projectId/sourceIds/scope/businessDate 简写）。
 */
export function boundaryClaimFromContext(context: Readonly<Record<string, unknown>>): JobObjectBoundary {
  const embedded = context.jobBoundary;
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    const record = embedded as Record<string, unknown>;
    return Object.freeze({
      businessDate: stringField(record, 'businessDate'),
      projectId: stringField(record, 'projectId'),
      sourceIds: normalizeSourceIds(Array.isArray(record.sourceIds) ? record.sourceIds : []),
      feedIds: normalizeSourceIds(Array.isArray(record.feedIds) ? record.feedIds : []),
      scope: record.scope === 'workspace' ? 'workspace' : null
    });
  }
  return Object.freeze({
    businessDate: stringField(context, 'businessDate'),
    projectId: stringField(context, 'projectId'),
    sourceIds: normalizeSourceIds(Array.isArray(context.sourceIds) ? context.sourceIds : []),
    feedIds: normalizeSourceIds(Array.isArray(context.feedIds) ? context.feedIds : []),
    scope: context.scope === 'workspace' ? 'workspace' : null
  });
}

/** 边界主张是否携带任一维度（全空 = 未主张，不做覆盖校验）。 */
export function hasBoundaryClaim(boundary: JobObjectBoundary): boolean {
  return boundary.businessDate !== null || boundary.projectId !== null || boundary.sourceIds.length > 0 || boundary.feedIds.length > 0 || boundary.scope !== null;
}

export const OBJECT_SCOPE_MISMATCH = 'OBJECT_SCOPE_MISMATCH';

/**
 * 各角色边界合同的强制维度（§8.1 锁键语义）：只有属于该角色对象键的维度才参与
 * 对象级硬隔离——planner 的 knowledge.record_batch 携带 sourceIds，但 planner 对象是
 * businessDate，source 维度不属于其合同，不得拦截合法同界写。
 */
const ROLE_BOUNDARY_DIMENSIONS: Readonly<Record<EmployeeRole, readonly ('businessDate' | 'projectId' | 'sourceIds' | 'feedIds' | 'scope')[]>> = Object.freeze({
  reporter: Object.freeze(['businessDate', 'sourceIds', 'feedIds'] as const),
  planner: Object.freeze(['businessDate'] as const),
  writer: Object.freeze(['businessDate', 'projectId'] as const),
  librarian: Object.freeze(['sourceIds', 'scope'] as const)
});

/** 把命令主张掩码到角色合同维度（非角色维度视为未主张，不做覆盖校验）。 */
export function maskBoundaryToRole(boundary: JobObjectBoundary, roleId: EmployeeRole): JobObjectBoundary {
  const dims = ROLE_BOUNDARY_DIMENSIONS[roleId];
  return Object.freeze({
    businessDate: dims.includes('businessDate') ? boundary.businessDate : null,
    projectId: dims.includes('projectId') ? boundary.projectId : null,
    sourceIds: dims.includes('sourceIds') ? boundary.sourceIds : EMPTY_SOURCE_IDS,
    feedIds: dims.includes('feedIds') ? boundary.feedIds : EMPTY_SOURCE_IDS,
    scope: dims.includes('scope') ? boundary.scope : null
  });
}

function boundaryMismatch(dimension: string, expected: unknown, got: unknown): CommandDispatchError {
  return new CommandDispatchError(
    'TASK_SCOPE_BROADENED',
    `${OBJECT_SCOPE_MISMATCH}: 命令对象超出工单边界（${dimension}）。`,
    { reason: OBJECT_SCOPE_MISMATCH, dimension, expected, got }
  );
}

/**
 * 纯对象边界校验器（§12.2.7，签发与执行两处硬门复用）：
 * 命令主张的每一非空维度必须被任务边界覆盖，缺失或越界 fail closed（TASK_SCOPE_BROADENED + OBJECT_SCOPE_MISMATCH）。
 */
export function assertBoundaryCovers(task: JobObjectBoundary, claim: JobObjectBoundary): void {
  if (claim.businessDate !== null) {
    if (task.businessDate === null) throw boundaryMismatch('businessDate', null, claim.businessDate);
    if (task.businessDate !== claim.businessDate) throw boundaryMismatch('businessDate', task.businessDate, claim.businessDate);
  }
  if (claim.projectId !== null) {
    if (task.projectId === null) throw boundaryMismatch('projectId', null, claim.projectId);
    if (task.projectId !== claim.projectId) throw boundaryMismatch('projectId', task.projectId, claim.projectId);
  }
  if (claim.sourceIds.length > 0) {
    if (task.scope !== 'workspace') {
      if (task.sourceIds.length === 0) throw boundaryMismatch('sourceIds', [], claim.sourceIds);
      for (const id of claim.sourceIds) {
        if (!task.sourceIds.includes(id)) throw boundaryMismatch('sourceIds', task.sourceIds, claim.sourceIds);
      }
    }
  }
  if (claim.feedIds.length > 0) {
    if (task.scope !== 'workspace') {
      if (task.feedIds.length === 0) throw boundaryMismatch('feedIds', [], claim.feedIds);
      for (const id of claim.feedIds) {
        if (!task.feedIds.includes(id)) throw boundaryMismatch('feedIds', task.feedIds, claim.feedIds);
      }
    }
  }
  if (claim.scope !== null) {
    if (task.scope !== claim.scope) throw boundaryMismatch('scope', task.scope, claim.scope);
  }
}

/** 签发期完整性：spawn 合同角色的关键边界维度缺失 → fail closed。 */
export function assertJobBoundaryComplete(boundary: JobObjectBoundary, roleId: EmployeeRole): void {
  if (roleId === 'writer' && boundary.projectId === null) throw boundaryMismatch('projectId', null, 'missing');
  if ((roleId === 'reporter' || roleId === 'planner') && boundary.businessDate === null) throw boundaryMismatch('businessDate', null, 'missing');
  if (roleId === 'librarian' && boundary.scope !== 'workspace' && boundary.sourceIds.length === 0) throw boundaryMismatch('scope', 'workspace', 'missing');
}
