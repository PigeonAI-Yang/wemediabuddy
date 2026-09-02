// WMB-5290 项目专项调查：renderer 侧展示辅助 + IPC 调用收口。
// 类型真源 = src/shared/project-investigation.ts（后端契约）；本文件只做
// 展示元数据、防御性归一化（后端落地前保持编译）与 wmb API 切片。

import { isRecord } from '../shared/wiki-operator-protocol';
import type {
  InvestigationDirection,
  InvestigationHistoryEvent,
  InvestigationOutline,
  InvestigationPackage,
  InvestigationReporterJob,
  InvestigationWriterJob,
  ProjectInvestigation,
  ProjectInvestigationStatus
} from '../shared/project-investigation';
import type { ResearchEvidencePack } from '../main/research-task-state';

// 展示别名：renderer 组件消费的名字；结构与后端契约同构。
export type StudioInvestigationStatus = ProjectInvestigationStatus;
export type StudioInvestigationOutline = InvestigationOutline;
export type StudioInvestigationDirection = InvestigationDirection;
export type StudioInvestigationEvidencePack = ResearchEvidencePack;
export type StudioInvestigationReview = InvestigationPackage['review'];
export type StudioInvestigationPackage = InvestigationPackage;
export type StudioInvestigationReporter = InvestigationReporterJob;
export type StudioInvestigationWriter = InvestigationWriterJob;
export type StudioInvestigationHistoryRow = InvestigationHistoryEvent;
export type StudioInvestigationModel = ProjectInvestigation;

/** 后端所有 mutation 返回 CommandResult {ok,data,error}；data 为完整读模型。 */
export type StudioInvestigationCommandResult = {
  ok: boolean;
  data: StudioInvestigationModel | null;
  error: { code: string; message: string } | null;
};

/** 后端 IPC 契约为准的 wmb 切片；全局 d.ts 落地前用本类型收口调用。 */
export type StudioInvestigationApi = {
  investigationGet(projectId: string): Promise<StudioInvestigationCommandResult>;
  investigationInitialize(projectId: string): Promise<StudioInvestigationCommandResult>;
  investigationSaveOutline(input: { projectId: string; expectedRevision: number; outline: StudioInvestigationOutline }): Promise<StudioInvestigationCommandResult>;
  investigationDecideOutline(input: { projectId: string; expectedRevision: number; decision: 'approve' | 'reject' }): Promise<StudioInvestigationCommandResult>;
  investigationReviewResearch(input: { projectId: string; expectedRevision: number; decision: 'accept' | 'defer' | 'supplement' | 'expand' | 'stop'; direction?: StudioInvestigationDirection }): Promise<StudioInvestigationCommandResult>;
  investigationSaveDirection(input: { projectId: string; expectedRevision: number; direction: StudioInvestigationDirection }): Promise<StudioInvestigationCommandResult>;
  investigationDecideDirection(input: { projectId: string; expectedRevision: number; decision: 'approve' | 'supplement' | 'stop' }): Promise<StudioInvestigationCommandResult>;
  investigationStartWriter(input: { projectId: string; expectedRevision: number }): Promise<StudioInvestigationCommandResult>;
  investigationRetryReporter(input: { projectId: string; expectedRevision: number }): Promise<StudioInvestigationCommandResult>;
};

// 后端 global.d.ts 落地前 window.wmb 尚无 investigation* 方法：此处一次性收口断言，
// 后续调用全部走 StudioInvestigationApi 类型，不逐点内联 cast。
const wmbWindow = window as unknown as Window & { wmb: Window['wmb'] & StudioInvestigationApi };

export const wmbInvestigation = (): StudioInvestigationApi => wmbWindow.wmb;

const STATUS_LABELS: Record<StudioInvestigationStatus, string> = {
  outline_pending_approval: '调查提纲待审批',
  outline_rejected: '调查提纲已驳回',
  researching: '记者专项调查中',
  research_review: '待主管验收调查资料包',
  needs_more_research: '需要补查',
  needs_user: '需要用户处理',
  direction_pending_approval: '调查后写作方向待审批',
  ready_to_write: '可以开始写作',
  writing: '写手写作中',
  completed: '调查流程已完成',
  abandoned: '已停止调查',
  failed: '调查失败'
};

export const investigationStatusLabel = (status: StudioInvestigationStatus | string | null | undefined): string =>
  status ? (STATUS_LABELS[status as StudioInvestigationStatus] ?? status) : '尚未开始调查';

const STATUS_TONES: Record<StudioInvestigationStatus, string> = {
  outline_pending_approval: 'accent',
  outline_rejected: 'danger',
  researching: 'accent',
  research_review: 'amber',
  needs_more_research: 'amber',
  needs_user: 'amber',
  direction_pending_approval: 'accent',
  ready_to_write: 'green',
  writing: 'accent',
  completed: 'green',
  abandoned: 'gray',
  failed: 'danger'
};

export const investigationStatusTone = (status: StudioInvestigationStatus | string | null | undefined): string =>
  status ? (STATUS_TONES[status as StudioInvestigationStatus] ?? 'gray') : 'gray';

export const INVESTIGATION_OUTLINE_FIELDS: Array<{ key: keyof StudioInvestigationOutline; label: string; kind: 'text' | 'list' }> = [
  { key: 'scope', label: '调查对象与边界', kind: 'text' },
  { key: 'known', label: '当前已知', kind: 'list' },
  { key: 'hypotheses', label: '当前假设', kind: 'list' },
  { key: 'questions', label: '核心调查问题', kind: 'list' },
  { key: 'dimensions', label: '事实维度', kind: 'list' },
  { key: 'materialRequirements', label: '材料要求', kind: 'list' },
  { key: 'truthRisks', label: '真实性风险', kind: 'list' },
  { key: 'disconfirmingConditions', label: '推翻条件', kind: 'list' },
  { key: 'completionCriteria', label: '完成标准', kind: 'list' },
  { key: 'exclusions', label: '暂不调查', kind: 'list' }
];

export const INVESTIGATION_DIRECTION_FIELDS: Array<{ key: keyof StudioInvestigationDirection; label: string; kind: 'text' | 'list' }> = [
  { key: 'keyFacts', label: '调查后最重要的事实', kind: 'list' },
  { key: 'upheld', label: '调查前判断中成立的', kind: 'list' },
  { key: 'changed', label: '需要收窄、修改或推翻的', kind: 'list' },
  { key: 'discoveries', label: '调查中新出现的关键观察', kind: 'list' },
  { key: 'unknowns', label: '仍然存在的未知与表达边界', kind: 'list' },
  { key: 'coreQuestion', label: '新的核心问题', kind: 'text' },
  { key: 'audienceValue', label: '受众价值', kind: 'text' },
  { key: 'scope', label: '文章范围', kind: 'text' },
  { key: 'constraints', label: '写作约束', kind: 'list' }
];

export const RECOMMENDATION_LABELS: Record<StudioInvestigationDirection['recommendation'], string> = {
  continue: '继续原角度',
  adjust: '调整角度',
  redirect: '采用新角度',
  stop: '停止写作'
};

export const CLAIM_STATUS_LABELS: Record<string, string> = {
  pending: '待判定',
  supported: '已证实',
  contradicted: '被反驳',
  unresolved: '无法确认',
  source_unavailable: '来源不可用'
};

export const TERMINAL_REASON_LABELS: Record<string, string> = {
  claims_resolved: '必答问题已全部判定',
  budget_exhausted: '预算用尽',
  candidates_exhausted: '候选来源耗尽',
  aborted: '中止'
};

export const HISTORY_KIND_LABELS: Record<string, string> = {
  initialized: '开始项目调查',
  outline_saved: '保存调查提纲',
  outline_approved: '生产调查范围已确认',
  outline_rejected: 'Owner 驳回调查提纲',
  reporter_dispatched: '派记者专项调查',
  reporter_retried: '重新派记者补查',
  research_succeeded: '记者交付调查资料包',
  research_failed: '记者调查失败',
  review_accepted: '主管验收通过',
  review_supplement: '要求补查',
  review_expanded: '扩展调查范围',
  review_stopped: '停止调查',
  needs_user_raised: '需要用户处理',
  direction_saved: '保存调查后写作方向',
  direction_approved: '主管冻结写作方向',
  direction_supplemented: '要求补充调查',
  direction_stopped: '停止写作方向',
  writer_started: '写手开始写作',
  writer_finished: '写手完成正文',
  completed: '流程完成',
  abandoned: '项目已停止'
};

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asNullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asOptionalNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function normalizeOutline(value: unknown): StudioInvestigationOutline | null {
  if (!isRecord(value)) return null;
  return {
    scope: asString(value.scope),
    exclusions: asStringList(value.exclusions),
    known: asStringList(value.known),
    hypotheses: asStringList(value.hypotheses),
    questions: asStringList(value.questions),
    dimensions: asStringList(value.dimensions),
    materialRequirements: asStringList(value.materialRequirements),
    truthRisks: asStringList(value.truthRisks),
    disconfirmingConditions: asStringList(value.disconfirmingConditions),
    completionCriteria: asStringList(value.completionCriteria)
  };
}

const RECOMMENDATIONS: StudioInvestigationDirection['recommendation'][] = ['continue', 'adjust', 'redirect', 'stop'];

function normalizeDirection(value: unknown): StudioInvestigationDirection | null {
  if (!isRecord(value)) return null;
  const recommendation = RECOMMENDATIONS.includes(value.recommendation as StudioInvestigationDirection['recommendation'])
    ? (value.recommendation as StudioInvestigationDirection['recommendation'])
    : 'continue';
  return {
    keyFacts: asStringList(value.keyFacts),
    upheld: asStringList(value.upheld),
    changed: asStringList(value.changed),
    discoveries: asStringList(value.discoveries),
    unknowns: asStringList(value.unknowns),
    recommendation,
    coreQuestion: asString(value.coreQuestion),
    audienceValue: asString(value.audienceValue),
    scope: asString(value.scope),
    constraints: asStringList(value.constraints)
  };
}

const STATUSES: StudioInvestigationStatus[] = [
  'outline_pending_approval', 'outline_rejected', 'researching', 'research_review',
  'needs_more_research', 'needs_user', 'direction_pending_approval', 'ready_to_write',
  'writing', 'completed', 'abandoned', 'failed'
];

const EMPTY_EVIDENCE_PACK: StudioInvestigationEvidencePack = {
  kind: 'research_evidence',
  jobId: '',
  round: 0,
  claims: [],
  sourceIds: [],
  validSourceCount: 0,
  candidateCount: 0,
  timeSpentMinutes: 0,
  terminalReason: 'candidates_exhausted',
  unresolvedRequiredClaims: []
};

function normalizeEvidencePack(value: unknown): StudioInvestigationEvidencePack {
  if (!isRecord(value) || value.kind !== 'research_evidence') return EMPTY_EVIDENCE_PACK;
  const claims = Array.isArray(value.claims)
    ? value.claims.filter(isRecord).map((claim) => ({
        id: asString(claim.id),
        key: asString(claim.key),
        status: (['pending', 'supported', 'contradicted', 'unresolved', 'source_unavailable'] as const).includes(claim.status as never)
          ? (claim.status as StudioInvestigationEvidencePack['claims'][number]['status'])
          : 'pending',
        verdictReason: asNullableString(claim.verdictReason),
        evidenceSourceIds: asStringList(claim.evidenceSourceIds),
        needsTimeExcerpt: claim.needsTimeExcerpt === true
      }))
    : [];
  return {
    kind: 'research_evidence',
    jobId: asString(value.jobId),
    round: typeof value.round === 'number' ? value.round : 0,
    claims,
    sourceIds: asStringList(value.sourceIds),
    validSourceCount: typeof value.validSourceCount === 'number' ? value.validSourceCount : 0,
    candidateCount: typeof value.candidateCount === 'number' ? value.candidateCount : 0,
    timeSpentMinutes: typeof value.timeSpentMinutes === 'number' ? value.timeSpentMinutes : 0,
    terminalReason: (['claims_resolved', 'budget_exhausted', 'candidates_exhausted', 'aborted'] as const).includes(value.terminalReason as never)
      ? (value.terminalReason as StudioInvestigationEvidencePack['terminalReason'])
      : 'candidates_exhausted',
    unresolvedRequiredClaims: asStringList(value.unresolvedRequiredClaims)
  };
}

function normalizePackage(value: unknown): StudioInvestigationPackage | null {
  if (!isRecord(value)) return null;
  const review = isRecord(value.review)
    ? {
        decision: (['accept', 'defer', 'supplement', 'expand', 'stop'] as const).includes(value.review.decision as never)
          ? (value.review.decision as 'accept' | 'defer' | 'supplement' | 'expand' | 'stop')
          : 'stop',
        summary: asNullableString(value.review.summary),
        decidedAt: asNullableString(value.review.decidedAt),
        decidedBy: asNullableString(value.review.decidedBy)
      }
    : null;
  return {
    pack: normalizeEvidencePack(value.pack ?? value.evidence),
    sourceIds: asStringList(value.sourceIds),
    review,
    createdAt: asString(value.createdAt)
  };
}

function normalizeReporter(value: unknown): StudioInvestigationReporter | null {
  if (!isRecord(value)) return null;
  return {
    jobId: asNullableString(value.jobId),
    taskId: asNullableString(value.taskId),
    outlineVersion: typeof value.outlineVersion === 'number' ? value.outlineVersion : 0,
    round: typeof value.round === 'number' ? value.round : 0,
    status: asNullableString(value.status),
    errorMessage: asNullableString(value.errorMessage),
    startedAt: asNullableString(value.startedAt),
    finishedAt: asNullableString(value.finishedAt)
  };
}

function normalizeWriter(value: unknown): StudioInvestigationWriter | null {
  if (!isRecord(value)) return null;
  return {
    jobId: asNullableString(value.jobId),
    status: asNullableString(value.status),
    startedAt: asNullableString(value.startedAt),
    finishedAt: asNullableString(value.finishedAt)
  };
}

/**
 * 读模型归一化：null/缺字段安全降级；所有防御性分支集中于此。
 * 后端契约落地后大部分分支不再触发，但保留以兼容旧 detail 缓存。
 */
export function normalizeInvestigationModel(value: unknown): StudioInvestigationModel | null {
  if (!isRecord(value)) return null;
  const status = STATUSES.includes(value.status as StudioInvestigationStatus)
    ? (value.status as StudioInvestigationStatus)
    : null;
  if (!status) return null;
  const history = Array.isArray(value.history)
    ? value.history.filter(isRecord).map((row) => ({
        kind: asString(row.kind),
        at: asString(row.at),
        note: asNullableString(row.note),
        version: asOptionalNumber(row.version)
      }))
    : [];
  const outlineStatus = value.outlineStatus === 'approved' || value.outlineStatus === 'rejected' ? value.outlineStatus : 'draft';
  const directionStatus = value.directionStatus === 'approved' || value.directionStatus === 'supplemented' ? value.directionStatus : 'draft';
  return {
    projectId: asString(value.projectId),
    status,
    revision: typeof value.revision === 'number' ? value.revision : 0,
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    outlineVersion: asOptionalNumber(value.outlineVersion) ?? asOptionalNumber(value.outlineRevision),
    outline: normalizeOutline(value.outline),
    outlineStatus,
    reporter: normalizeReporter(value.reporter),
    package: normalizePackage(value.package),
    directionVersion: asOptionalNumber(value.directionVersion) ?? asOptionalNumber(value.directionRevision),
    direction: normalizeDirection(value.direction),
    directionStatus,
    writer: normalizeWriter(value.writer),
    history
  };
}

/**
 * IPC 返回归一化：mutation/get 可能返回 CommandResult {ok,data,error} 或裸读模型；
 * 兼容两种形状，非读模型返回 null。
 */
export function unwrapInvestigationResult(value: unknown): StudioInvestigationModel | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok === 'boolean' && 'data' in value) return normalizeInvestigationModel(value.data);
  return normalizeInvestigationModel(value);
}

export const blankOutline = (): StudioInvestigationOutline => ({
  scope: '',
  exclusions: [],
  known: [],
  hypotheses: [],
  questions: [],
  dimensions: [],
  materialRequirements: [],
  truthRisks: [],
  disconfirmingConditions: [],
  completionCriteria: []
});

export const blankDirection = (): StudioInvestigationDirection => ({
  keyFacts: [],
  upheld: [],
  changed: [],
  discoveries: [],
  unknowns: [],
  recommendation: 'continue',
  coreQuestion: '',
  audienceValue: '',
  scope: '',
  constraints: []
});

export const outlinesEqual = (a: StudioInvestigationOutline, b: StudioInvestigationOutline): boolean =>
  a.scope === b.scope
  && a.exclusions.join('\u0001') === b.exclusions.join('\u0001')
  && a.known.join('\u0001') === b.known.join('\u0001')
  && a.hypotheses.join('\u0001') === b.hypotheses.join('\u0001')
  && a.questions.join('\u0001') === b.questions.join('\u0001')
  && a.dimensions.join('\u0001') === b.dimensions.join('\u0001')
  && a.materialRequirements.join('\u0001') === b.materialRequirements.join('\u0001')
  && a.truthRisks.join('\u0001') === b.truthRisks.join('\u0001')
  && a.disconfirmingConditions.join('\u0001') === b.disconfirmingConditions.join('\u0001')
  && a.completionCriteria.join('\u0001') === b.completionCriteria.join('\u0001');

export const directionsEqual = (a: StudioInvestigationDirection, b: StudioInvestigationDirection): boolean =>
  a.recommendation === b.recommendation
  && a.coreQuestion === b.coreQuestion
  && a.audienceValue === b.audienceValue
  && a.scope === b.scope
  && a.keyFacts.join('\u0001') === b.keyFacts.join('\u0001')
  && a.upheld.join('\u0001') === b.upheld.join('\u0001')
  && a.changed.join('\u0001') === b.changed.join('\u0001')
  && a.discoveries.join('\u0001') === b.discoveries.join('\u0001')
  && a.unknowns.join('\u0001') === b.unknowns.join('\u0001')
  && a.constraints.join('\u0001') === b.constraints.join('\u0001');
