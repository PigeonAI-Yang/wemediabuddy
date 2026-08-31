import type { PlanningStatus } from './planning-stage.ts';
import type { ContentProjectDetail } from './content.ts';

export type StudioTruth = {
  planningStatus: PlanningStatus | null;
  versionCount: number;
  canShowWriter: boolean;
  canAdvance: boolean;
  awaitingApproval: boolean;
  emptyBodyLabel: string;
  activeTasks: ContentProjectDetail['activeTasks'];
};

export const PLANNING_STATUS_COPY: Record<PlanningStatus, string> = {
  draft: '草稿 · 待策划/待补证据',
  ready_for_review: '待主管审批',
  approved: '已批准 · 生产推进中',
  rejected: '已驳回',
};

export function deriveStudioTruth(detail: ContentProjectDetail | null): StudioTruth | null {
  if (!detail) return null;
  const planningStatus = detail.planningStatus ?? null;
  const versionCount = detail.versionCount ?? 0;
  const isApproved = planningStatus === 'approved';
  const awaitingApproval = planningStatus === 'ready_for_review';
  return {
    planningStatus,
    versionCount,
    canShowWriter: isApproved,
    canAdvance: isApproved,
    awaitingApproval,
    emptyBodyLabel: versionCount === 0 ? '尚未生成正文' : `第 ${versionCount} 版`,
    activeTasks: detail.activeTasks ?? [],
  };
}
