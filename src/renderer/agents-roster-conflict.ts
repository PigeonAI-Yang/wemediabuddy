/**
 * 主管席冲突投影（WMB-5137）：仅真实 blocked / 资源冲突显示危险态。
 * 正常 desk running + 员工 running 的编排（主管对话不占员工槽）不是冲突。
 * 逻辑与视图分离，便于 node:test 直接做行为断言（无 jsdom）。
 */

/** 工单 waiting_resource 且 waitReason 携带的真实资源冲突码（实体锁 / 租约忙）。 */
export const ROSTER_CONFLICT_WAIT_CODES = ['RESOURCE_LOCK_CONFLICT', 'RESOURCE_LEASE_BUSY'] as const;

export type DeskConflictJobLike = {
  status?: string | null;
  waitReason?: string | null;
};

export type DeskConflictInput = {
  deskOccupied: boolean;
  /** desk 角色卡状态：'idle' | 'running' | 'blocked' | 'unknown'。 */
  deskStatus?: string | null;
  /** 工单板投影（真实工单 + 后台任务镜像）。 */
  jobs?: ReadonlyArray<DeskConflictJobLike> | null;
};

/**
 * 冲突危险态判定：
 * - 主管席未占用 → 永远非冲突（主管对话可随时进行）。
 * - 主管席受阻（needs_user → blocked / 权限 BLOCKED）→ 冲突。
 * - 存在工单等待真实资源冲突（RESOURCE_LOCK_CONFLICT / RESOURCE_LEASE_BUSY）→ 冲突。
 * - 编排性等待（RESOURCE_JUDGE_IN_FLIGHT 等）与正常并行 running → 非冲突。
 */
export function resolveDeskConflict(input: DeskConflictInput): boolean {
  const { deskOccupied, deskStatus, jobs } = input;
  if (!deskOccupied) return false;
  if (deskStatus === 'blocked') return true;
  for (const job of jobs ?? []) {
    if (job?.status !== 'waiting_resource') continue;
    const reason = job.waitReason ?? '';
    if (ROSTER_CONFLICT_WAIT_CODES.some((code) => reason.startsWith(code))) return true;
  }
  return false;
}
