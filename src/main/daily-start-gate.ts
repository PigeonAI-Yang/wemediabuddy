/**
 * Pure decision for agent:start-daily-intelligence early-return / handoff.
 * Basic agent path — must stay unit-tested.
 */
export type DailyStartGateTask = {
  status: string;
  phase: string;
  intent?: string;
  /** saved sources from progress, if known */
  savedCount?: number;
} | null | undefined;

export type DailyStartGateDecision =
  | { action: 'return_active' }
  | { action: 'start_full' }
  | { action: 'start_judge_only' };

/**
 * @param hasLiveCoordinator true when dailyRuns has this date
 */
export function decideDailyStartGate(input: {
  active: DailyStartGateTask;
  hasLiveCoordinator: boolean;
  /** latest terminal task for the date (partial/succeeded/failed) when active is null */
  latest?: DailyStartGateTask;
}): DailyStartGateDecision {
  const active = input.active;
  if (active && active.status === 'running') {
    if (input.hasLiveCoordinator) return { action: 'return_active' };

    // Scan finished, coordinator gone → only restart judgment, do not re-scan.
    if (active.phase === 'channel_scanned') return { action: 'start_judge_only' };

    if (active.phase === 'resume_pending') return { action: 'start_full' };

    const phase = String(active.phase || '');
    // 无 live coordinator 的 starting/scanning = 协调器已死，允许重新开扫。
    if (
      phase === 'starting'
      || phase === 'channel_preflight'
      || phase === 'planning_sources'
      || phase.startsWith('scanning')
    ) {
      return { action: 'start_full' };
    }
    // 判断阶段协调器已死 → 只重跑判断。
    if (/judg|synth|validat|running_pi|plan/i.test(phase)) {
      return { action: 'start_judge_only' };
    }

    // 未知运行中阶段：保守不双开。
    return { action: 'return_active' };
  }

  // Terminal partial with inventory already in DB: continue = judge only.
  const latest = input.latest;
  if (latest && latest.status === 'partial' && !input.hasLiveCoordinator) {
    return { action: 'start_judge_only' };
  }

  return { action: 'start_full' };
}
