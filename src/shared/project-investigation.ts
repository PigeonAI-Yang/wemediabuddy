/**
 * WMB-5290 项目专项调查与事实驱动写作流程（设计 docs/spark/2026-08-16-project-investigation-writing-workflow-design.md）。
 *
 * 本文件是渲染层/预加载层消费的规范类型与 IPC 通道常量（真源）。
 * 业务实现与持久化映射见 src/main/project-investigation.ts；
 * 资料包 `pack` 复用既有 ResearchEvidencePack（src/main/research-task-state.ts，类型只读引用，
 * 与 global.d.ts 从 ../main/content 引类型的仓库惯例一致）。
 */

import type { ResearchEvidencePack } from '../main/research-task-state.ts';

export type ProjectInvestigationStatus =
  | 'outline_pending_approval'
  | 'outline_rejected'
  | 'researching'
  | 'research_review'
  | 'needs_more_research'
  | 'needs_user'
  | 'direction_pending_approval'
  | 'ready_to_write'
  | 'writing'
  | 'completed'
  | 'abandoned'
  | 'failed';

/** 调查提纲（调查地图，非文章提纲；问题导向）。 */
export type InvestigationOutline = Readonly<{
  scope: string;
  exclusions: readonly string[];
  known: readonly string[];
  hypotheses: readonly string[];
  questions: readonly string[];
  dimensions: readonly string[];
  materialRequirements: readonly string[];
  truthRisks: readonly string[];
  disconfirmingConditions: readonly string[];
  completionCriteria: readonly string[];
}>;

/** 调查后写作方向（第二次 Owner 审批对象）。 */
export type InvestigationDirection = Readonly<{
  keyFacts: readonly string[];
  upheld: readonly string[];
  changed: readonly string[];
  discoveries: readonly string[];
  unknowns: readonly string[];
  recommendation: 'continue' | 'adjust' | 'redirect' | 'stop';
  coreQuestion: string;
  audienceValue: string;
  scope: string;
  constraints: readonly string[];
}>;

/** 项目调查读模型中的记者工单投影（权威运行记录在智能体工单；此处仅必要状态）。 */
export type InvestigationReporterJob = Readonly<{
  jobId: string | null;
  taskId: string | null;
  /** 派单时绑定的已确认提纲版本（不可变快照）。 */
  outlineVersion: number;
  /** 第几轮调查（补查/重试递增；资料包按轮不可变保留）。 */
  round: number;
  /** 工单池状态投影：queued|waiting_resource|running|succeeded|failed|cancelled|partial|needs_user。 */
  status: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}>;

/** 项目调查读模型中的写手工单投影。 */
export type InvestigationWriterJob = Readonly<{
  jobId: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}>;

/** 主管验收（资料包审阅）记录。 */
export type InvestigationPackageReview = Readonly<{
  decision: 'accept' | 'supplement' | 'expand' | 'stop';
  summary: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}>;

/** 调查资料包（按轮不可变；`pack` 为精确 EvidencePack，正文永不复制来源主体）。 */
export type InvestigationPackage = Readonly<{
  pack: ResearchEvidencePack;
  /** 本包关联的来源 ID（同时写入既有 content_project_sources 关系表）。 */
  sourceIds: readonly string[];
  review: InvestigationPackageReview | null;
  createdAt: string;
}>;

export type InvestigationHistoryEvent = Readonly<{
  kind: string;
  at: string;
  note: string | null;
  version: number | null;
}>;

/**
 * 项目调查读模型（ContentProjectDetail.investigation 同型；每个项目至多一个活动调查轮次）。
 * outline/outlineVersion = 当前（最新）提纲版本；outlineStatus = 该版本的审批状态；
 * direction/directionStatus 同理；reporter/package/writer 为最近状态投影。
 */
export type ProjectInvestigation = Readonly<{
  projectId: string;
  status: ProjectInvestigationStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  outlineVersion: number | null;
  outline: InvestigationOutline | null;
  outlineStatus: 'draft' | 'approved' | 'rejected' | null;
  reporter: InvestigationReporterJob | null;
  package: InvestigationPackage | null;
  directionVersion: number | null;
  direction: InvestigationDirection | null;
  directionStatus: 'draft' | 'approved' | 'supplemented' | null;
  writer: InvestigationWriterJob | null;
  /** 全部审批、状态转换与调查轮次的审计流水。 */
  history: readonly InvestigationHistoryEvent[];
}>;

/** 渲染层 API 名（window.wmb.investigation*，camelCase）与 IPC 通道映射（唯一真源）。 */
export const INVESTIGATION_IPC = Object.freeze({
  get: 'investigation:get',
  initialize: 'investigation:initialize',
  saveOutline: 'investigation:save-outline',
  decideOutline: 'investigation:decide-outline',
  reviewResearch: 'investigation:review-research',
  saveDirection: 'investigation:save-direction',
  decideDirection: 'investigation:decide-direction',
  startWriter: 'investigation:start-writer',
  retryReporter: 'investigation:retry-reporter'
} as const);

/** 变更类渲染层 API 的统一返回（每次返回完整 ProjectInvestigation 读模型）。 */
export type InvestigationCommandResult =
  | { ok: true; data: ProjectInvestigation; error: null }
  | { ok: false; data: null; error: { code: string; message: string; details?: Record<string, unknown> } };

export type InvestigationDecideOutlineInput = {
  projectId: string;
  expectedRevision: number;
  decision: 'approve' | 'reject';
};

export type InvestigationReviewResearchInput = {
  projectId: string;
  expectedRevision: number;
  decision: 'accept' | 'supplement' | 'expand' | 'stop';
  direction?: InvestigationDirection;
};

export type InvestigationDecideDirectionInput = {
  projectId: string;
  expectedRevision: number;
  decision: 'approve' | 'supplement' | 'stop';
};

/** 主管（desk）派记者时的合成稳定父身份：parentJobId/parentTaskId 同值（每项目恒一）。 */
export function investigationParentId(projectId: string): string {
  return `investigation:${projectId}`;
}

/** 研究缺口合成 gapId：同一项目同一提纲版本同一轮次恒同（重放/审计稳定）。 */
export function investigationGapId(projectId: string, outlineVersion: number, round: number): string {
  return `investigation:${projectId}:outline:${outlineVersion}:round:${round}`;
}
